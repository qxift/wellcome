"use client";

import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DoubleSide,
  MathUtils,
  RepeatWrapping,
  Vector3,
  TextureLoader,
  type Texture,
  SRGBColorSpace,
  type Group,
} from "three";
import type { CabinetItem } from "@/data/cabinetItems";

type CabinetPanoramaProps = {
  items: CabinetItem[];
};

type CabinetGroup = {
  id: string;
  items: CabinetItem[];
};

type CabinetStyle = {
  width: number;
  height: number;
  depth: number;
  y: number;
  wood: string;
  woodTextureIndex: number;
  trim: string;
  back: string;
  crown: "flat" | "stepped" | "arch";
  foot: "block" | "bun" | "none";
  furnitureType: "tall-cabinet" | "bookcase" | "vitrine-table" | "sideboard" | "wall-case";
};

type CompartmentSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  type: "door-left" | "door-right";
};

type FocusTarget = {
  cameraPosition: [number, number, number];
  lookAt: [number, number, number];
  yaw: number;
};

type CameraPose = {
  cameraPosition: [number, number, number];
  yaw: number;
};

type FurniturePlacement = {
  position: [number, number, number];
  rotationY: number;
};

const playerRadius = 0.28;
const roomRadius = 5.2;
const itemsPerCabinet = 4;
const doorsPerCabinet = 16;

function trimTitle(title: string) {
  return title.replace(/^\[/, "").replace(/\]\.?$/, "");
}

function cleanYear(year: string) {
  return year.replace(/^\[/, "").replace(/\]$/, "");
}

function hashSeed(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function chunkItems(items: CabinetItem[]): CabinetGroup[] {
  if (items.length === 0) {
    return [];
  }

  const numCabinets = 9;
  const groups: CabinetGroup[] = [];

  for (let i = 0; i < numCabinets; i++) {
    const startIndex = i * itemsPerCabinet;
    const endIndex = Math.min(startIndex + itemsPerCabinet, items.length);
    const cabinetItems = items.slice(startIndex, endIndex);

    if (cabinetItems.length > 0) {
      groups.push({
        id: cabinetItems.map((item) => item.id).join("-"),
        items: cabinetItems,
      });
    }
  }

  return groups;
}

function getUnifiedCabinetWidth(totalGroups: number) {
  const depth = 0.6;
  const radius = roomRadius - depth * 0.5 + 0.3;

  if (totalGroups === 1) {
    return Math.max(3.8, Math.min(4.4, radius * 0.8));
  }

  const span = (Math.PI * 2) / Math.max(totalGroups, 1);
  const outerWidth = 2 * radius * Math.sin(span / 2);

  return Math.max(1.18, outerWidth);
}

function getCabinetStyle(group: CabinetGroup, index: number, totalGroups: number): CabinetStyle {
  return {
    width: getUnifiedCabinetWidth(totalGroups),
    height: 4.02,
    depth: 1.2, // Increased depth to ensure full wall coverage
    y: 0,
    wood: "#2c1408",
    woodTextureIndex: 1,
    trim: "#d3a95f",
    back: group.items[0]?.color ?? "#7b5732",
    crown: "flat",
    foot: "none",
    furnitureType: "tall-cabinet",
  };
}

function getCompartmentSpecs(style: CabinetStyle, count: number, _seed: number): CompartmentSpec[] {
  const innerWidth = style.width - 0.02;
  const innerHeight = style.height - 0.02;
  const columns = 4;
  const rows = 4;
  const gap = 0.002;
  const specs: CompartmentSpec[] = [];
  const columnWidth = (innerWidth - gap * (columns - 1)) / columns;
  const rowHeight = (innerHeight - gap * (rows - 1)) / rows;

  let cursorX = -innerWidth / 2;

  for (let column = 0; column < columns; column += 1) {
    const width = columnWidth;

    for (let row = 0; row < rows; row += 1) {
      if (specs.length >= count) break;

      const height = Math.max(0.34, rowHeight);
      const x = cursorX + width / 2;
      const y = innerHeight / 2 - rowHeight / 2 - row * (rowHeight + gap);

      specs.push({
        x,
        y,
        width,
        height,
        type: column % 2 === 0 ? "door-left" : "door-right",
      });
    }

    cursorX += width + gap;
  }

  return specs;
}

function getCabinetOuterFootprint(style: CabinetStyle) {
  return {
    width: style.width ,
    depth: style.depth + 0.12,
  };
}

function getDoorIdsForGroups(groups: CabinetGroup[]) {
  return groups.flatMap((group, groupIndex) => {
    const style = getCabinetStyle(group, groupIndex, groups.length);
    const seed = hashSeed(`${group.id}-${groupIndex}-layout`);
    const specs = getCompartmentSpecs(style, doorsPerCabinet, seed);

    return specs.map((_, specIndex) => `${group.id}-${specIndex}`);
  });
}

function getUniqueDoorItemId(
  items: CabinetItem[],
  currentDoorItems: Record<string, string>,
  doorId: string,
  offset: number,
) {
  if (items.length === 0) {
    return "";
  }

  const usedItemIds = new Set(
    Object.entries(currentDoorItems)
      .filter(([candidateDoorId]) => candidateDoorId !== doorId)
      .map(([, itemId]) => itemId),
  );

  for (let index = 0; index < items.length; index += 1) {
    const candidate = items[(hashSeed(doorId) + offset + index) % items.length];

    if (!usedItemIds.has(candidate.id)) {
      return candidate.id;
    }
  }

  return items[(hashSeed(doorId) + offset) % items.length]?.id ?? "";
}

function getFurniturePlacements(groups: CabinetGroup[]): FurniturePlacement[] {
  if (groups.length === 0) {
    return [];
  }

  const styles = groups.map((group, index) => getCabinetStyle(group, index, groups.length));
  const footprints = styles.map((style) => getCabinetOuterFootprint(style));
  const maxDepth = Math.max(...footprints.map((footprint) => footprint.depth));
  const radius = roomRadius; // Position cabinets at the wall radius
  const spans = footprints.map((footprint) => {
    const chord = footprint.width;
    return 2 * Math.asin(Math.min(1, chord / (2 * radius)));
  });
  const totalSpan = spans.reduce((sum, span) => sum + span, 0);
  const gapAngle = 0; // Make cabinets touch each other
  const placements: FurniturePlacement[] = [];
  let cursor = groups.length === 1 ? 0 : 0;

  spans.forEach((span) => {
    cursor += span / 2;
    const x = Math.sin(cursor) * radius;
    const z = -Math.cos(cursor) * radius;

    placements.push({
      position: [x, 0, z],
      rotationY: -cursor,
    });

    cursor += span / 2 + gapAngle;
  });

  return placements;
}

function rotateY([x, y, z]: [number, number, number], rotationY: number): [number, number, number] {
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);

  return [x * cos + z * sin, y, -x * sin + z * cos];
}

function addVec3([ax, ay, az]: [number, number, number], [bx, by, bz]: [number, number, number]): [number, number, number] {
  return [ax + bx, ay + by, az + bz];
}

function getDoorFocusTarget(
  group: CabinetGroup,
  index: number,
  specIndex: number,
  placement: FurniturePlacement,
  totalGroups: number,
): FocusTarget | null {
  const style = getCabinetStyle(group, index, totalGroups);
  const seed = hashSeed(`${group.id}-${index}-layout`);
  const specs = getCompartmentSpecs(style, doorsPerCabinet, seed);
  const spec = specs[specIndex];

  if (!spec) {
    return null;
  }
  const basePosition: [number, number, number] = [
    placement.position[0],
    placement.position[1] + style.y,
    placement.position[2],
  ];
  const localLookAt: [number, number, number] = [spec.x, spec.y, style.depth * 0.28];
  const localCamera: [number, number, number] = [spec.x, spec.y + 0.02, style.depth * 2.2];
  const worldLookAt = addVec3(basePosition, rotateY(localLookAt, placement.rotationY));
  const worldCamera = addVec3(basePosition, rotateY(localCamera, placement.rotationY));

  return {
    cameraPosition: worldCamera,
    lookAt: worldLookAt,
    yaw: placement.rotationY + Math.PI,
  };
}

function buildBackstory(item: CabinetItem) {
  const year = cleanYear(item.year || "an unknown year");
  const title = trimTitle(item.title);

  return `You have opened a cabinet of ${item.theme.toLowerCase()}. This object dates to ${year}. ${title} It survives as a witness to how spectacle, medicine, and public fascination were once folded together in the same room.`;
}

function getLookAtFromPose(pose: CameraPose): [number, number, number] {
  return [
    pose.cameraPosition[0] - Math.sin(pose.yaw),
    pose.cameraPosition[1],
    pose.cameraPosition[2] - Math.cos(pose.yaw),
  ];
}

function getFocusTargetFromPose(pose: CameraPose): FocusTarget {
  return {
    cameraPosition: pose.cameraPosition,
    lookAt: getLookAtFromPose(pose),
    yaw: pose.yaw,
  };
}

function chooseNarrationVoice(voices: SpeechSynthesisVoice[]) {
  const preferredNames = [
    "samantha",
    "ava",
    "allison",
    "moira",
    "serena",
    "karen",
    "daniel",
    "libby",
    "aria",
    "jenny",
    "zira",
    "google uk english female",
    "google us english",
  ];

  return [...voices]
    .filter((voice) => voice.lang.toLowerCase().startsWith("en"))
    .sort((left, right) => {
      const scoreVoice = (voice: SpeechSynthesisVoice) => {
        const name = voice.name.toLowerCase();
        let score = 0;

        if (voice.default) score += 20;
        if (voice.localService) score += 15;
        if (voice.lang.toLowerCase().startsWith("en-gb")) score += 8;
        if (voice.lang.toLowerCase().startsWith("en-us")) score += 6;
        if (preferredNames.some((preferred) => name.includes(preferred))) score += 30;
        if (name.includes("female")) score += 6;
        if (name.includes("natural")) score += 8;
        if (name.includes("enhanced")) score += 5;
        if (name.includes("compact")) score -= 8;
        if (name.includes("novelty")) score -= 20;

        return score;
      };

      return scoreVoice(right) - scoreVoice(left);
    })[0];
}

function playCabinetShakeSound() {
  if (typeof window === "undefined") {
    return;
  }

  const AudioContextClass = window.AudioContext ?? (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;

  if (!AudioContextClass) {
    return;
  }

  const audioContext = new AudioContextClass();
  const startAt = audioContext.currentTime + 0.02;
  const burstDurations = [0.12, 0.11, 0.13, 0.1];
  let cursor = startAt;

  burstDurations.forEach((duration, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();

    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(92 + index * 10, cursor);
    oscillator.frequency.linearRampToValueAtTime(138 + index * 8, cursor + duration);

    filter.type = "bandpass";
    filter.frequency.setValueAtTime(620, cursor);
    filter.Q.setValueAtTime(2.8, cursor);

    gain.gain.setValueAtTime(0.0001, cursor);
    gain.gain.linearRampToValueAtTime(0.06, cursor + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, cursor + duration);

    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(cursor);
    oscillator.stop(cursor + duration);
    cursor += duration + 0.045;
  });

  void audioContext.resume();
  window.setTimeout(() => {
    void audioContext.close().catch(() => undefined);
  }, 900);
}

type FloorRect = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

function expandRect(rect: FloorRect, amount: number): FloorRect {
  return {
    minX: rect.minX - amount,
    maxX: rect.maxX + amount,
    minZ: rect.minZ - amount,
    maxZ: rect.maxZ + amount,
  };
}

function pointInRect(x: number, z: number, rect: FloorRect) {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

function getFurnitureBlockers(groups: CabinetGroup[], placements: FurniturePlacement[]) {
  return groups.map((group, index) => {
    const style = getCabinetStyle(group, index, groups.length);
    const placement = placements[index];

    if (!placement) {
      return expandRect({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, 0);
    }

    const footprint = getCabinetOuterFootprint(style);
    const facesSideWall = Math.abs(Math.sin(placement.rotationY)) > 0.7;
    const footprintWidth = facesSideWall ? footprint.depth : footprint.width;
    const footprintDepth = facesSideWall ? footprint.width : footprint.depth;

    return expandRect(
      {
        minX: placement.position[0] - footprintWidth / 2,
        maxX: placement.position[0] + footprintWidth / 2,
        minZ: placement.position[2] - footprintDepth / 2,
        maxZ: placement.position[2] + footprintDepth / 2,
      },
      playerRadius + 0.08,
    );
  });
}

function canStandAt(x: number, z: number, blockers: FloorRect[]) {
  if (Math.hypot(x, z) > roomRadius - playerRadius) {
    return false;
  }

  return !blockers.some((blocker) => pointInRect(x, z, blocker));
}

function RoomArchitecture({
  wallpaperTexture,
  rugTexture,
  floorTexture,
}: {
  wallpaperTexture?: Texture | null;
  rugTexture?: Texture | null;
  floorTexture?: Texture | null;
}) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.92, 0]} receiveShadow>
        <circleGeometry args={[roomRadius, 96]} />
        <meshStandardMaterial
          map={floorTexture ?? undefined}
          color={floorTexture ? "#ffffff" : "#5a3217"}
          roughness={0.86}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.35, -1.915, -0.25]}>
        <circleGeometry args={[1.82, 48]} />
        <meshStandardMaterial
          map={rugTexture ?? undefined}
          color={rugTexture ? "#ffffff" : "#7c1f18"}
          roughness={0.92}
        />
      </mesh>

      <mesh position={[0, 2.18, 0]}>
        <cylinderGeometry args={[0.22, 0.32, 0.18, 20]} />
        <meshStandardMaterial color="#3b1a0a" roughness={0.76} />
      </mesh>
      <mesh position={[0, 1.9, 0]}>
        <sphereGeometry args={[0.18, 24, 24]} />
        <meshStandardMaterial color="#ffe0ad" emissive="#d38a3d" emissiveIntensity={1.5} />
      </mesh>
      <pointLight position={[0, 1.8, 0]} intensity={4.5} color="#ffd49b" distance={7} />

      {Array.from({ length: 10 }, (_, index) => {
        const angle = (index / 10) * Math.PI * 2;
        return (
          <group key={`crystal-${index}`} position={[Math.sin(angle) * 0.42, 1.62, -Math.cos(angle) * 0.42]}>
            <mesh>
              <cylinderGeometry args={[0.01, 0.01, 0.34, 6]} />
              <meshStandardMaterial color="#bfa675" roughness={0.36} metalness={0.55} />
            </mesh>
            <mesh position={[0, -0.24, 0]}>
              <octahedronGeometry args={[0.07]} />
              <meshPhysicalMaterial color="#fff7dc" transparent opacity={0.62} roughness={0.03} transmission={0.35} />
            </mesh>
          </group>
        );
      })}

      {[0.9, 2.7, 4.5].map((angle, index) => (
        <group key={`lamp-${index}`} position={[Math.sin(angle) * 2.8, 1.7, -Math.cos(angle) * 2.8]}>
          <sphereGeometry args={[0.1, 20, 20]} />
          <meshStandardMaterial color="#ffe0ad" emissive="#d38a3d" emissiveIntensity={1.1} />
          <pointLight intensity={2.2} color="#ffd49b" distance={4.5} />
        </group>
      ))}
    </group>
  );
}

function ItemDisplay({
  item,
  spec,
  style,
  open,
  interactionLocked,
}: {
  item: CabinetItem;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  interactionLocked: boolean;
}) {
  const texture = useLoader(TextureLoader, item.imageUrl, (loader) => {
    loader.crossOrigin = "anonymous";
  });
  const displayTexture = useMemo(() => {
    const nextTexture = texture.clone();
    nextTexture.colorSpace = SRGBColorSpace;
    return nextTexture;
  }, [texture]);
  const { imageWidth, imageHeight } = useMemo(() => {
    const maxWidth = spec.width * 0.68;
    const maxHeight = spec.height * 0.58;
    const source = texture.image as { width?: number; height?: number } | undefined;
    const sourceWidth = source?.width ?? 1;
    const sourceHeight = source?.height ?? 1;
    const aspectRatio = sourceWidth / Math.max(1, sourceHeight);

    if (aspectRatio >= maxWidth / maxHeight) {
      return {
        imageWidth: maxWidth,
        imageHeight: maxWidth / Math.max(aspectRatio, 0.001),
      };
    }

    return {
      imageWidth: maxHeight * aspectRatio,
      imageHeight: maxHeight,
    };
  }, [spec.height, spec.width, texture.image]);
  const displayZ = open ? -style.depth * 0.5 : style.depth * 0.3; // Adjusted for deeper cabinets
  const displayY = spec.y;

  return (
    <group position={[spec.x, displayY, displayZ]}>
      <mesh raycast={() => null} scale={open ? 1.06 : 1} visible={open} renderOrder={10}>
        <planeGeometry args={[imageWidth, imageHeight]} />
        <meshBasicMaterial map={displayTexture} transparent side={DoubleSide} depthTest={!open} depthWrite={!open} />
      </mesh>
    </group>
  );
}


function ClickableFront({
  doorId,
  spec,
  style,
  open,
  shaking,
  interactionLocked,
  onToggle,
  woodTexture,
}: {
  doorId: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  shaking: boolean;
  interactionLocked: boolean;
  woodTexture?: Texture | null;
  onToggle: (doorId: string) => void;
}) {
  const frontRef = useRef<Group>(null);
  const frontZ = style.depth * 0.15; // Adjusted for new depth
  const hingeDirection = spec.type === "door-left" ? -1 : 1;
  const arcDepth = spec.width * 0.04;
  const doorWoodMaterialProps = {
    map: woodTexture ?? undefined,
    color: woodTexture ? "#ffffff" : style.wood,
    roughness: 0.78,
    metalness: 0.04,
  };

  useFrame((_, delta) => {
    if (!frontRef.current) return;

    const openAngle = hingeDirection * (Math.PI * 110 / 180);
    const shakeOffset = shaking ? Math.sin(performance.now() * 0.035) * 0.16 : 0;
    const targetRotation = (open ? openAngle : 0) + shakeOffset;

    frontRef.current.rotation.y = MathUtils.damp(
      frontRef.current.rotation.y,
      targetRotation,
      shaking ? 18 : 10,
      delta,
    );
  });

  const handleClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (interactionLocked) return;
    onToggle(doorId);
  };

  return (
    <group
      ref={frontRef}
      position={[spec.x + hingeDirection * spec.width * 0.5, spec.y, frontZ]}
      onClick={handleClick}
    >
      <mesh position={[-hingeDirection * spec.width * 0.5, 0, 0.02 + arcDepth]} castShadow>
        <boxGeometry args={[spec.width + 0.02, spec.height + 0.02, 0.08]} />
        <meshStandardMaterial {...doorWoodMaterialProps} roughness={0.78} />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, spec.height * 0.26, 0.095 + arcDepth]}>
        <boxGeometry args={[spec.width - 0.12, 0.032, 0.028]} />
        <meshStandardMaterial color="#d3a95f" roughness={0.34} metalness={0.62} />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, -spec.height * 0.26, 0.095 + arcDepth]}>
        <boxGeometry args={[spec.width - 0.12, 0.032, 0.028]} />
        <meshStandardMaterial color="#d3a95f" roughness={0.34} metalness={0.62} />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.82, -spec.height * 0.12, 0.11 + arcDepth]}>
        <sphereGeometry args={[0.045, 18, 18]} />
        <meshStandardMaterial color="#d3a95f" roughness={0.28} metalness={0.72} />
      </mesh>
    </group>
  );
}

function CabinetCompartment({
  doorId,
  item,
  spec,
  style,
  woodTexture,
  open,
  shaking,
  interactionLocked,
  onToggle,
}: {
  doorId: string;
  item: CabinetItem;
  spec: CompartmentSpec;
  style: CabinetStyle;
  woodTexture?: Texture | null;
  open: boolean;
  shaking: boolean;
  interactionLocked: boolean;
  onToggle: (doorId: string) => void;
}) {
  const lockerDepth = style.depth * 0.8; // Adjusted for new depth
  const innerWidth = spec.width - 0.04;
  const innerHeight = spec.height - 0.04;
  const wallThickness = 0.035;
  const frontLipDepth = 0.08;
  const interiorWood = woodTexture
    ? "#ffffff"
    : "#4a2411";

  return (
    <>
      <group position={[spec.x, spec.y, style.depth * 0.02]}>
        <mesh position={[0, 0, -lockerDepth * 0.42]}>
          <boxGeometry args={[innerWidth, innerHeight, wallThickness]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.8}
          />
        </mesh>
        <mesh position={[-innerWidth * 0.5 + wallThickness * 0.5, 0, -lockerDepth * 0.18]}>
          <boxGeometry args={[wallThickness, innerHeight, lockerDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
        <mesh position={[innerWidth * 0.5 - wallThickness * 0.5, 0, -lockerDepth * 0.18]}>
          <boxGeometry args={[wallThickness, innerHeight, lockerDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
        <mesh position={[0, innerHeight * 0.5 - wallThickness * 0.5, -lockerDepth * 0.18]}>
          <boxGeometry args={[innerWidth, wallThickness, lockerDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
        <mesh position={[0, -innerHeight * 0.5 + wallThickness * 0.5, -lockerDepth * 0.18]}>
          <boxGeometry args={[innerWidth, wallThickness, lockerDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
        <mesh position={[-innerWidth * 0.5 + wallThickness * 0.5, 0, lockerDepth * 0.3]}>
          <boxGeometry args={[wallThickness, innerHeight, frontLipDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
        <mesh position={[innerWidth * 0.5 - wallThickness * 0.5, 0, lockerDepth * 0.3]}>
          <boxGeometry args={[wallThickness, innerHeight, frontLipDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
        <mesh position={[0, innerHeight * 0.5 - wallThickness * 0.5, lockerDepth * 0.3]}>
          <boxGeometry args={[innerWidth, wallThickness, frontLipDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
        <mesh position={[0, -innerHeight * 0.5 + wallThickness * 0.5, lockerDepth * 0.3]}>
          <boxGeometry args={[innerWidth, wallThickness, frontLipDepth]} />
          <meshStandardMaterial
            map={woodTexture ?? undefined}
            color={interiorWood}
            roughness={0.82}
          />
        </mesh>
      </group>
      <ItemDisplay
        item={item}
        spec={spec}
        style={style}
        open={open}
        interactionLocked={interactionLocked}
      />
      <ClickableFront
        doorId={doorId}
        spec={spec}
        style={style}
        open={open}
        shaking={shaking}
        interactionLocked={interactionLocked}
        woodTexture={woodTexture}
        onToggle={onToggle}
      />
    </>
  );
}

function SpecimenDome({
  x,
  y,
  z,
  accent,
}: {
  x: number;
  y: number;
  z: number;
  accent: string;
}) {
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, -0.18, 0]}>
        <cylinderGeometry args={[0.32, 0.38, 0.12, 24]} />
        <meshStandardMaterial color="#2a1308" roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.18, 0]}>
        <sphereGeometry args={[0.28, 24, 16]} />
        <meshPhysicalMaterial
          color="#d8f2ff"
          transparent
          opacity={0.18}
          roughness={0.04}
          transmission={0.55}
        />
      </mesh>
      <mesh position={[0, 0.08, 0]}>
        <coneGeometry args={[0.12, 0.38, 7]} />
        <meshStandardMaterial color={accent} roughness={0.7} />
      </mesh>
    </group>
  );
}

function AntiqueAdornment({
  group,
  style,
  seed,
  woodTexture,
}: {
  group: CabinetGroup;
  style: CabinetStyle;
  seed: number;
  woodTexture?: Texture | null;
}) {
  const brass = "#d3a95f";
  const frontZ = style.depth * 0.88;
  const topY = style.height * 0.58;
  const woodMaterialProps = {
    map: woodTexture ?? undefined,
    color: "#ffffff",
    roughness: 0.82,
    metalness: 0.08,
  };

  return null;
}

function CabinetPanel({
  group,
  index,
  totalGroups,
  placement,
  focusedDoorId,
  allItems,
  doorItemIds,
  shakingDoorId,
  interactionLocked,
  woodTextures,
  onToggleDoor,
}: {
  group: CabinetGroup;
  index: number;
  totalGroups: number;
  placement: FurniturePlacement;
  focusedDoorId: string;
  allItems: CabinetItem[];
  doorItemIds: Record<string, string>;
  shakingDoorId: string;
  interactionLocked: boolean;
  woodTextures: Texture[];
  onToggleDoor: (doorId: string) => void;
}) {
  const style = getCabinetStyle(group, index, totalGroups);
  const seed = hashSeed(`${group.id}-${index}-layout`);
  const specs = getCompartmentSpecs(style, doorsPerCabinet, seed);

  const cabinetWoodTexture = woodTextures[style.woodTextureIndex];
  const woodMaterialProps = {
    map: cabinetWoodTexture ?? undefined,
    color: "#ffffff",
    roughness: 0.82,
    metalness: 0.08,
  };

  return (
    <group
      position={[placement.position[0], placement.position[1] + style.y, placement.position[2]]}
      rotation={[0, placement.rotationY, 0]}
    >
      <mesh position={[0, 0, -style.depth * 0.4]} receiveShadow castShadow>
        <boxGeometry args={[style.width * 0.995, style.height, 0.08]} />
        <meshStandardMaterial {...woodMaterialProps} />
      </mesh>

      {specs
        .map((spec, specIndex) => ({ spec, specIndex }))
        .map(({ spec, specIndex }) => {
          const doorId = `${group.id}-${specIndex}`;
          const item =
            allItems.find((candidate) => candidate.id === doorItemIds[doorId]) ??
            allItems[(index * doorsPerCabinet + specIndex) % allItems.length];

          return (
            <CabinetCompartment
              key={doorId}
              doorId={doorId}
              item={item}
              spec={spec}
              style={style}
              woodTexture={cabinetWoodTexture}
              open={focusedDoorId === doorId}
              shaking={shakingDoorId === doorId}
              interactionLocked={interactionLocked}
              onToggle={onToggleDoor}
            />
          );
        })}
    </group>
  );
}

function WasdCamera({
  blockers,
  focusTarget,
  onRoamPoseChange,
  onTargetReached,
  targetMode,
}: {
  blockers: FloorRect[];
  focusTarget: FocusTarget | null;
  onRoamPoseChange: (pose: CameraPose) => void;
  onTargetReached: (mode: "focus" | "return") => void;
  targetMode: "focus" | "return" | null;
}) {
  const { camera } = useThree();
  const cameraRef = useRef(camera);
  const keys = useRef<Record<string, boolean>>({});
  const yaw = useRef(0);
  const lookAtRef = useRef(new Vector3(0, 0, -1));
  const settledTargetModeRef = useRef<"focus" | "return" | null>(null);

  useEffect(() => {
    cameraRef.current = camera;
    cameraRef.current.position.set(0, 0.05, 0.25);
    cameraRef.current.rotation.set(0, 0, 0);
    lookAtRef.current.set(0, 0.05, -1);
    onRoamPoseChange({ cameraPosition: [0, 0.05, 0.25], yaw: 0 });
  }, [camera, onRoamPoseChange]);

  useEffect(() => {
    const setKey = (event: KeyboardEvent, pressed: boolean) => {
      const key = event.key.toLowerCase();

      if (["w", "a", "s", "d"].includes(key)) {
        event.preventDefault();
        keys.current[key] = pressed;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => setKey(event, true);
    const handleKeyUp = (event: KeyboardEvent) => setKey(event, false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    settledTargetModeRef.current = null;
  }, [focusTarget, targetMode]);

  useFrame((_, delta) => {
    const sceneCamera = cameraRef.current;
    const turnSpeed = 1.85;
    const walkSpeed = 2.05;

    if (focusTarget) {
      sceneCamera.position.x = MathUtils.damp(sceneCamera.position.x, focusTarget.cameraPosition[0], 5.5, delta);
      sceneCamera.position.y = MathUtils.damp(sceneCamera.position.y, focusTarget.cameraPosition[1], 5.5, delta);
      sceneCamera.position.z = MathUtils.damp(sceneCamera.position.z, focusTarget.cameraPosition[2], 5.5, delta);
      yaw.current = MathUtils.damp(yaw.current, focusTarget.yaw, 5.5, delta);
      lookAtRef.current.x = MathUtils.damp(lookAtRef.current.x, focusTarget.lookAt[0], 5.5, delta);
      lookAtRef.current.y = MathUtils.damp(lookAtRef.current.y, focusTarget.lookAt[1], 5.5, delta);
      lookAtRef.current.z = MathUtils.damp(lookAtRef.current.z, focusTarget.lookAt[2], 5.5, delta);
      sceneCamera.lookAt(lookAtRef.current);

      if (targetMode && settledTargetModeRef.current !== targetMode) {
        const distance =
          Math.abs(sceneCamera.position.x - focusTarget.cameraPosition[0]) +
          Math.abs(sceneCamera.position.y - focusTarget.cameraPosition[1]) +
          Math.abs(sceneCamera.position.z - focusTarget.cameraPosition[2]);
        const yawDistance = Math.abs(yaw.current - focusTarget.yaw);

        if (distance < 0.03 && yawDistance < 0.03) {
          settledTargetModeRef.current = targetMode;
          onTargetReached(targetMode);
        }
      }

      return;
    }

    const forward = Number(Boolean(keys.current.w)) - Number(Boolean(keys.current.s));
    const turn = Number(Boolean(keys.current.a)) - Number(Boolean(keys.current.d));

    yaw.current += turn * turnSpeed * delta;

    if (forward !== 0) {
      const nextX = sceneCamera.position.x - Math.sin(yaw.current) * forward * walkSpeed * delta;
      const nextZ = sceneCamera.position.z - Math.cos(yaw.current) * forward * walkSpeed * delta;

      if (canStandAt(nextX, nextZ, blockers)) {
        sceneCamera.position.x = nextX;
        sceneCamera.position.z = nextZ;
      } else if (canStandAt(nextX, sceneCamera.position.z, blockers)) {
        sceneCamera.position.x = nextX;
      } else if (canStandAt(sceneCamera.position.x, nextZ, blockers)) {
        sceneCamera.position.z = nextZ;
      }
    }

    sceneCamera.rotation.set(0, yaw.current, 0);
    lookAtRef.current.set(
      sceneCamera.position.x - Math.sin(yaw.current),
      sceneCamera.position.y,
      sceneCamera.position.z - Math.cos(yaw.current),
    );
    onRoamPoseChange({
      cameraPosition: [sceneCamera.position.x, sceneCamera.position.y, sceneCamera.position.z],
      yaw: yaw.current,
    });
  });

  return null;
}

function CabinetRoom({
  allItems,
  groups,
  placements,
  focusedDoorId,
  doorItemIds,
  shakingDoorId,
  interactionLocked,
  woodTextures,
  wallpaperTexture,
  rugTexture,
  floorTexture,
  focusTarget,
  targetMode,
  onRoamPoseChange,
  onTargetReached,
  onToggleDoor,
}: {
  allItems: CabinetItem[];
  groups: CabinetGroup[];
  placements: FurniturePlacement[];
  focusedDoorId: string;
  doorItemIds: Record<string, string>;
  shakingDoorId: string;
  interactionLocked: boolean;
  woodTextures: Texture[];
  wallpaperTexture?: Texture | null;
  rugTexture?: Texture | null;
  floorTexture?: Texture | null;
  focusTarget: FocusTarget | null;
  targetMode: "focus" | "return" | null;
  onRoamPoseChange: (pose: CameraPose) => void;
  onTargetReached: (mode: "focus" | "return") => void;
  onToggleDoor: (doorId: string) => void;
}) {
  const blockers = useMemo(() => getFurnitureBlockers(groups, placements), [groups, placements]);

  return (
    <>
      <color attach="background" args={["#24140b"]} />
      <fog attach="fog" args={["#24140b", 6.5, 15]} />
      <ambientLight intensity={1.55} />
      <hemisphereLight args={["#ffe0ad", "#6b3a1d", 1.25]} />
      <pointLight position={[0, 2.6, 0]} intensity={10} color="#ffe0ad" />
      <pointLight position={[-2.8, 1.7, -1.5]} intensity={4.5} color="#fff1cf" />
      <pointLight position={[2.8, 1.7, 1.5]} intensity={4.5} color="#ffd09a" />
      <spotLight
        position={[0, 2.8, 1.2]}
        angle={0.7}
        penumbra={0.75}
        intensity={12}
        color="#ffe2b8"
        castShadow
      />

      <RoomArchitecture
        wallpaperTexture={wallpaperTexture}
        rugTexture={rugTexture}
        floorTexture={floorTexture}
      />
      <WasdCamera
        blockers={blockers}
        focusTarget={focusTarget}
        onRoamPoseChange={onRoamPoseChange}
        onTargetReached={onTargetReached}
        targetMode={targetMode}
      />

      <group>
        {groups.map((group, index) => {
          return (
            <CabinetPanel
              key={group.id}
              group={group}
              index={index}
              totalGroups={groups.length}
              placement={placements[index]}
              focusedDoorId={focusedDoorId}
              allItems={allItems}
              doorItemIds={doorItemIds}
              shakingDoorId={shakingDoorId}
              interactionLocked={interactionLocked}
              woodTextures={woodTextures}
              onToggleDoor={onToggleDoor}
            />
          );
        })}
      </group>
    </>
  );
}

const cabinetWoodTextureFiles = [
  "/wood-surface.jpg",
  "/dark_wood.jpg",
  "/light_wood.jpg",
  "/medium_light_wood.jpg",
];

export function CabinetPanorama({ items }: CabinetPanoramaProps) {
  const groups = useMemo(() => chunkItems(items), [items]);
  const doorIds = useMemo(() => getDoorIdsForGroups(groups), [groups]);
  const placements = useMemo(() => getFurniturePlacements(groups), [groups]);
  const initialDoorItemIds = useMemo(() => {
    const nextDoorItemIds: Record<string, string> = {};

    if (items.length === 0) {
      return nextDoorItemIds;
    }

    doorIds.forEach((doorId, index) => {
      const item = items[index % items.length];
      nextDoorItemIds[doorId] = item.id;
    });

    return nextDoorItemIds;
  }, [doorIds, items]);
  const [doorItemIds, setDoorItemIds] = useState<Record<string, string>>(() => initialDoorItemIds);
  const [doorOpenCounts, setDoorOpenCounts] = useState<Record<string, number>>({});
  const [selectedItemId, setSelectedItemId] = useState("");
  const [focusedDoorId, setFocusedDoorId] = useState("");
  const [returnPose, setReturnPose] = useState<CameraPose | null>(null);
  const [shakingDoorId, setShakingDoorId] = useState("");
  const [interactionLocked, setInteractionLocked] = useState(false);
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const [woodTextures, setWoodTextures] = useState<Texture[]>([]);
  const [wallpaperTexture, setWallpaperTexture] = useState<Texture | null>(null);
  const [rugTexture, setRugTexture] = useState<Texture | null>(null);
  const [floorTexture, setFloorTexture] = useState<Texture | null>(null);
  const mountedRef = useRef(false);
  const roamPoseRef = useRef<CameraPose>({
    cameraPosition: [0, 0.05, 0.25],
    yaw: 0,
  });
  const narrationDoorIdRef = useRef("");
  const pendingPostStoryShakeRef = useRef(false);
  const shakeTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setDoorItemIds(initialDoorItemIds);
    setDoorOpenCounts({});
    setSelectedItemId("");
    setFocusedDoorId("");
    setReturnPose(null);
    setShakingDoorId("");
    setInteractionLocked(false);
    pendingPostStoryShakeRef.current = false;
  }, [initialDoorItemIds]);

  const cabinetFocusTarget = useMemo(() => {
    if (!focusedDoorId) {
      return null;
    }

    const specSeparatorIndex = focusedDoorId.lastIndexOf("-");

    if (specSeparatorIndex === -1) {
      return null;
    }

    const groupId = focusedDoorId.slice(0, specSeparatorIndex);
    const specIndex = Number(focusedDoorId.slice(specSeparatorIndex + 1));
    const groupIndex = groups.findIndex((group) => group.id === groupId);

    if (groupIndex === -1 || Number.isNaN(specIndex)) {
      return null;
    }

    const placement = placements[groupIndex];

    if (!placement) {
      return null;
    }

    return getDoorFocusTarget(groups[groupIndex], groupIndex, specIndex, placement, groups.length);
  }, [focusedDoorId, groups, placements]);

  const focusTarget = useMemo(() => {
    if (cabinetFocusTarget) {
      return cabinetFocusTarget;
    }

    if (returnPose) {
      return getFocusTargetFromPose(returnPose);
    }

    return null;
  }, [cabinetFocusTarget, returnPose]);

  const targetMode: "focus" | "return" | null = cabinetFocusTarget
    ? "focus"
    : returnPose
      ? "return"
      : null;

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    const loader = new TextureLoader();
    loader.setCrossOrigin("anonymous");

    const loadedTextures: Array<Texture | null> = Array(cabinetWoodTextureFiles.length).fill(null);
    let loadedCount = 0;

    cabinetWoodTextureFiles.forEach((url, index) => {
      loader.load(url, (texture) => {
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
        texture.repeat.set(2.4, 1.2);
        texture.colorSpace = SRGBColorSpace;
        loadedTextures[index] = texture;
        loadedCount += 1;

        if (loadedCount === cabinetWoodTextureFiles.length) {
          setWoodTextures(loadedTextures as Texture[]);
        }
      });
    });

    loader.load("/wallpaper.jpg", (wallTex) => {
      wallTex.wrapS = RepeatWrapping;
      wallTex.wrapT = RepeatWrapping;
      wallTex.repeat.set(4, 2);
      wallTex.colorSpace = SRGBColorSpace;
      setWallpaperTexture(wallTex);
    });

    loader.load("/rug.jpg", (texture) => {
      texture.colorSpace = SRGBColorSpace;
      setRugTexture(texture);
    });

    loader.load("/floor.jpg", (texture) => {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.repeat.set(5, 5);
      texture.colorSpace = SRGBColorSpace;
      setFloorTexture(texture);
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    const speech = window.speechSynthesis;
    speech.cancel();

    if (!selectedItem || !focusedDoorId) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(buildBackstory(selectedItem));
    const applyVoice = () => {
      const preferredVoice = chooseNarrationVoice(speech.getVoices());

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
    };

    applyVoice();
    narrationDoorIdRef.current = focusedDoorId;
    setInteractionLocked(true);
    utterance.rate = 0.9;
    utterance.pitch = 0.88;
    utterance.volume = 1;
    utterance.onend = () => {
      pendingPostStoryShakeRef.current = true;
      setReturnPose(roamPoseRef.current);
      setFocusedDoorId("");
      setSelectedItemId("");
    };

    const handleVoicesChanged = () => {
      applyVoice();
    };

    speech.addEventListener("voiceschanged", handleVoicesChanged);
    speech.speak(utterance);

    return () => {
      speech.removeEventListener("voiceschanged", handleVoicesChanged);
      speech.cancel();
    };
  }, [focusedDoorId, selectedItem]);

  useEffect(() => {
    return () => {
      if (shakeTimeoutRef.current !== null) {
        window.clearTimeout(shakeTimeoutRef.current);
      }
    };
  }, []);

  const toggleDoor = (doorId: string) => {
    if (interactionLocked) {
      return;
    }

    if (focusedDoorId === doorId) {
      if (items.length > 0) {
        const nextCount = (doorOpenCounts[doorId] ?? 0) + 1;
        const nextItemId = getUniqueDoorItemId(items, doorItemIds, doorId, nextCount * 7);

        setDoorOpenCounts((currentCounts) => ({ ...currentCounts, [doorId]: nextCount }));
        setDoorItemIds((currentItems) => ({ ...currentItems, [doorId]: nextItemId }));
      }

      pendingPostStoryShakeRef.current = false;
      setReturnPose(roamPoseRef.current);
      setFocusedDoorId("");
      setSelectedItemId("");
      return;
    }

    if (items.length > 0) {
      const currentItemId = doorItemIds[doorId];
      const currentItem =
        items.find((candidate) => candidate.id === currentItemId) ??
        items[hashSeed(doorId) % Math.max(items.length, 1)];

      if (!currentItem) {
        return;
      }

      setSelectedItemId(currentItem.id);
      setFocusedDoorId(doorId);
      setReturnPose(null);
    }
  };

  const handleRoamPoseChange = useCallback((pose: CameraPose) => {
    roamPoseRef.current = pose;
  }, []);

  const handleTargetReached = useCallback((mode: "focus" | "return") => {
    if (mode === "return") {
      setReturnPose(null);

      if (pendingPostStoryShakeRef.current && groups.length > 0) {
        const groupIndex = Math.floor(Math.random() * groups.length);
        const doorIndex = Math.floor(Math.random() * doorsPerCabinet);
        const nextDoorId = `${groups[groupIndex].id}-${doorIndex}`;

        pendingPostStoryShakeRef.current = false;
        setShakingDoorId(nextDoorId);
        playCabinetShakeSound();

        if (shakeTimeoutRef.current !== null) {
          window.clearTimeout(shakeTimeoutRef.current);
        }

        shakeTimeoutRef.current = window.setTimeout(() => {
          setShakingDoorId("");
          setInteractionLocked(false);
          shakeTimeoutRef.current = null;
        }, 1200);
      } else {
        setInteractionLocked(false);
      }
    }
  }, [groups]);

  return (
    <section className="panorama-shell" aria-label="Cabinet of curiosities panorama">
      <div className="panorama-stage">
        <Canvas
          camera={{ position: [0, 0.05, 0.25], fov: 72, near: 0.1, far: 40 }}
          shadows
          gl={{ antialias: true, alpha: false }}
        >
          {woodTextures.length > 0 && wallpaperTexture && rugTexture && floorTexture && (
            <Suspense fallback={null}>
              <CabinetRoom
                allItems={items}
                groups={groups}
                placements={placements}
                focusedDoorId={focusedDoorId}
                doorItemIds={doorItemIds}
                shakingDoorId={shakingDoorId}
                interactionLocked={interactionLocked}
                woodTextures={woodTextures}
                wallpaperTexture={wallpaperTexture}
                rugTexture={rugTexture}
                floorTexture={floorTexture}
                focusTarget={focusTarget}
                targetMode={targetMode}
                onRoamPoseChange={handleRoamPoseChange}
                onTargetReached={handleTargetReached}
                onToggleDoor={toggleDoor}
              />
            </Suspense>
          )}
        </Canvas>

        <div className="panorama-vignette" />
      </div>
    </section>
  );
}
