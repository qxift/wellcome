"use client";

import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box3,
  DoubleSide,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  Vector3,
  TextureLoader,
  type Texture,
  SRGBColorSpace,
  type Group,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CabinetItem } from "@/data/cabinetItems";

type CabinetPanoramaProps = {
  items: CabinetItem[];
};

type CabinetGroup = {
  id: string;
  keyword: string;
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
const roomRadius = 6.27;
const itemsPerCabinet = 8;
const doorsPerCabinet = 8;
const cabinetsPerRow = 13;
const rowsPerCabinet = 4;
const columnsPerCabinet = 2;
const forceNeutralModelPreviewMaterial = false;
// Preview tuning: adjust these to make neutral preview less bright
const previewMaterialColor = "#c0b9ad";
const previewMaterialRoughness = 0.7;
const previewMaterialMetalness = 0.02;

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

function buildLinkKeywordCounts(items: CabinetItem[]) {
  const keywordCounts = new Map<string, number>();

  for (const item of items) {
    for (const keyword of item.linkKeywords ?? []) {
      keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1);
    }
  }

  return keywordCounts;
}

function getItemDistinctivenessScore(item: CabinetItem, keywordCounts: Map<string, number>) {
  const keywords = item.linkKeywords ?? [];

  if (keywords.length === 0) {
    return 0;
  }

  return keywords.reduce((score, keyword) => {
    const count = keywordCounts.get(keyword) ?? 1;
    return score + 1 / count;
  }, 0);
}

function chunkItems(items: CabinetItem[]): CabinetGroup[] {
  if (items.length === 0) {
    return [];
  }

  const keywordCounts = buildLinkKeywordCounts(items);

  const keywordGroups = [...keywordCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([keyword]) => ({
      keyword,
      items: items
        .filter((item) => item.linkKeywords?.includes(keyword))
        .sort((left, right) => {
          const scoreDifference =
            getItemDistinctivenessScore(right, keywordCounts) - getItemDistinctivenessScore(left, keywordCounts);

          if (scoreDifference !== 0) {
            return scoreDifference;
          }

          const keywordCountDifference = (right.linkKeywords?.length ?? 0) - (left.linkKeywords?.length ?? 0);
          if (keywordCountDifference !== 0) {
            return keywordCountDifference;
          }

          return left.title.localeCompare(right.title);
        }),
    }))
    .filter((group) => group.items.length > 0);

  if (keywordGroups.length === 0) {
    return Array.from({ length: cabinetsPerRow }, (_, cabinetIndex) => {
      const cabinetItems = Array.from({ length: itemsPerCabinet }, (_, itemIndex) => {
        const sourceIndex = (cabinetIndex * itemsPerCabinet + itemIndex) % items.length;
        return items[sourceIndex];
      });

      return {
        id: `cabinet-${cabinetIndex}-misc`,
        keyword: "misc",
        items: cabinetItems,
      };
    });
  }

  return Array.from({ length: cabinetsPerRow }, (_, cabinetIndex) => {
    const group = keywordGroups[cabinetIndex % keywordGroups.length];

    return {
      id: `cabinet-${cabinetIndex}-${group.keyword.replace(/\s+/g, "-")}`,
      keyword: group.keyword,
      items: group.items,
    };
  });
}

function getUnifiedCabinetWidth(_totalGroups: number) {
  return 3;
}

function getCabinetStyle(group: CabinetGroup, index: number, totalGroups: number): CabinetStyle {
  return {
    width: getUnifiedCabinetWidth(totalGroups),
    height: 4.02,
    depth: 1.2, // Increased depth to ensure full wall coverage
    y: 0,
    wood: "#4a2b1a",
    woodTextureIndex: 0,
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
  const columns = 2;
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

function buildDoorItemPools(groups: CabinetGroup[], items: CabinetItem[]) {
  return Object.fromEntries(
    groups.flatMap((group, groupIndex) => {
      const style = getCabinetStyle(group, groupIndex, groups.length);
      const seed = hashSeed(`${group.id}-${groupIndex}-layout`);
      const specs = getCompartmentSpecs(style, doorsPerCabinet, seed);
      const pool = group.items.length > 0 ? group.items : items;

      return specs.map((_, specIndex) => {
        const doorId = `${group.id}-${specIndex}`;
        return [doorId, pool.map((item) => item.id)];
      });
    }),
  ) as Record<string, string[]>;
}

function chooseNextPoolItem(
  pool: string[],
  currentItemId: string | undefined,
  seenItemIds: Record<string, boolean>,
  itemsById: Map<string, CabinetItem>,
) {
  if (pool.length === 0) {
    return "";
  }

  const unseen3dItemId = pool.find((itemId) => {
    if (seenItemIds[itemId]) {
      return false;
    }

    return Boolean(itemsById.get(itemId)?.modelUrl);
  });
  if (unseen3dItemId) {
    return unseen3dItemId;
  }

  const unseenImageItemId = pool.find((itemId) => !seenItemIds[itemId]);
  if (unseenImageItemId) {
    return unseenImageItemId;
  }

  const seen3dItemId = pool.find((itemId) => Boolean(itemsById.get(itemId)?.modelUrl));
  if (seen3dItemId) {
    return seen3dItemId;
  }

  if (pool.length === 1) {
    return pool[0];
  }

  const currentIndex = currentItemId ? pool.indexOf(currentItemId) : -1;
  return pool[currentIndex === -1 ? 0 : (currentIndex + 1) % pool.length] ?? pool[0];
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
  const localLookAt: [number, number, number] = [spec.x, spec.y, style.depth * 0.42];
  const localCamera: [number, number, number] = [spec.x, spec.y + 0.02, style.depth * 1.45];
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
  active,
}: {
  item: CabinetItem;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  active: boolean;
}) {
  const objectRef = useRef<Group>(null);
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

  useFrame((state, delta) => {
    if (!objectRef.current) return;

    const targetFloatY = active ? Math.sin(state.clock.elapsedTime * 1.3) * 0.012 : 0;
    const targetRotationY = active ? Math.sin(state.clock.elapsedTime * 0.7) * 0.08 : 0;

    objectRef.current.position.y = MathUtils.damp(objectRef.current.position.y, targetFloatY, 4, delta);
    objectRef.current.rotation.y = MathUtils.damp(objectRef.current.rotation.y, targetRotationY, 4, delta);
    objectRef.current.rotation.x = MathUtils.damp(objectRef.current.rotation.x, active ? -0.04 : 0, 4, delta);
  });

  const objectDepth = Math.min(0.16, Math.max(0.07, Math.min(imageWidth, imageHeight) * 0.18));
  const bodyColor = item.color || "#8a7a68";
  const displayZ = open ? style.depth * 0.38 : style.depth * 0.1;
  const displayY = spec.y - spec.height * 0.04;

  return (
    <group position={[spec.x, displayY, displayZ]} renderOrder={11}>
      <group ref={objectRef} scale={open ? 1.04 : 1}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[imageWidth, imageHeight, objectDepth]} />
          <meshStandardMaterial attach="material-0" color={bodyColor} roughness={0.7} />
          <meshStandardMaterial attach="material-1" color={bodyColor} roughness={0.7} />
          <meshStandardMaterial attach="material-2" color={bodyColor} roughness={0.66} />
          <meshStandardMaterial attach="material-3" color={bodyColor} roughness={0.72} />
          <meshBasicMaterial
            attach="material-4"
            map={displayTexture}
            transparent
            side={DoubleSide}
          />
          <meshStandardMaterial attach="material-5" color={bodyColor} roughness={0.74} />
        </mesh>
      </group>
    </group>
  );
}

function ModelDisplay({
  modelUrl,
  spec,
  style,
  open,
  active,
}: {
  modelUrl: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  active: boolean;
}) {
  const gltf = useLoader(GLTFLoader, modelUrl);
  const scene = useMemo(() => {
    const cloned = gltf.scene.clone(true);

    cloned.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;

        if (forceNeutralModelPreviewMaterial) {
          if (Array.isArray(child.material)) {
            child.material = child.material.map(
              () =>
                new MeshStandardMaterial({
                  color: previewMaterialColor,
                  roughness: previewMaterialRoughness,
                  metalness: previewMaterialMetalness,
                }),
            );
          } else {
            child.material = new MeshStandardMaterial({
              color: previewMaterialColor,
              roughness: previewMaterialRoughness,
              metalness: previewMaterialMetalness,
            });
          }

          return;
        }

        const materials = Array.isArray(child.material) ? child.material : [child.material];

        materials.forEach((material) => {
          if (!material) return;

          if ("map" in material && material.map) {
            material.map.colorSpace = SRGBColorSpace;
          }

          material.needsUpdate = true;
        });
      }
    });

    return cloned;
  }, [gltf]);
  const { scale, center } = useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const size = new Vector3();
    const centerVec = new Vector3();
    box.getSize(size);
    box.getCenter(centerVec);
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const target = Math.min(spec.width, spec.height) * 1.02;

    return {
      scale: (target / maxDim) * 0.78,
      center: centerVec,
    };
  }, [scene, spec.height, spec.width]);
  const objectRef = useRef<Group>(null);
  const spinXRef = useRef(0);
  const spinYRef = useRef(0);
  const displayZ = open ? style.depth * 0.44 : style.depth * 0.1;
  const displayY = spec.y - spec.height * 0.04;

  useFrame((state, delta) => {
    if (!objectRef.current) return;

    const targetFloatY = active ? Math.sin(state.clock.elapsedTime * 1.3) * 0.016 : 0;

    if (active) {
      spinXRef.current += delta * 0.7;
      spinYRef.current += delta * 1.05;
    } else {
      spinXRef.current = MathUtils.damp(spinXRef.current, 0, 8, delta);
      spinYRef.current = MathUtils.damp(spinYRef.current, 0, 8, delta);
    }

    objectRef.current.position.y = MathUtils.damp(objectRef.current.position.y, targetFloatY, 4.5, delta);
    objectRef.current.rotation.x = spinXRef.current;
    objectRef.current.rotation.y = spinYRef.current;
  });

  return (
    <group position={[spec.x, displayY, displayZ]} renderOrder={11}>
      <ambientLight intensity={1.0} />
      <pointLight position={[0, spec.height * 0.15, 0.4]} intensity={2.2} color="#fff4d8" distance={2.4} />
      <group ref={objectRef}>
        <primitive object={scene} scale={scale} position={[-center.x, -center.y, -center.z]} />
      </group>
    </group>
  );
}


function ClickableFront({
  doorId,
  spec,
  style,
  open,
  interactionLocked,
  onToggle,
  woodTexture,
}: {
  doorId: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  interactionLocked: boolean;
  woodTexture?: Texture | null;
  onToggle: (doorId: string) => void;
}) {
  const frontRef = useRef<Group>(null);
  const frontZ = style.depth * 0.15; // Adjusted for new depth
  const hingeDirection = spec.type === "door-left" ? -1 : 1;
  const arcDepth = spec.width * 0.04;
  const doorFrameTexture = useMemo(() => {
    if (!woodTexture) {
      return null;
    }

    const texture = woodTexture.clone();
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(0.45, 1.4);
    texture.needsUpdate = true;
    return texture;
  }, [woodTexture]);
  const doorWoodMaterialProps = {
    map: doorFrameTexture ?? woodTexture ?? undefined,
    color: style.wood,
    roughness: 0.78,
    metalness: 0.04,
  };
  const glassInsetWidth = Math.max(0.12, spec.width - 0.22);
  const glassInsetHeight = Math.max(0.16, spec.height - 0.22);

  useFrame((_, delta) => {
    if (!frontRef.current) return;

    const openAngle = hingeDirection * (Math.PI * 110 / 180);
    const targetRotation = open ? openAngle : 0;

    frontRef.current.rotation.y = MathUtils.damp(
      frontRef.current.rotation.y,
      targetRotation,
      10,
      delta,
    );
  });

  const handleClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (interactionLocked && !open) return;
    onToggle(doorId);
  };

  return (
    <group
      ref={frontRef}
      position={[spec.x + hingeDirection * spec.width * 0.5, spec.y, frontZ]}
      onClick={handleClick}
    >
      <mesh position={[-hingeDirection * 0.05, 0, 0.02 + arcDepth]} castShadow>
        <boxGeometry args={[0.1, spec.height + 0.02, 0.08]} />
        <meshStandardMaterial {...doorWoodMaterialProps} roughness={0.82} />
      </mesh>
      <mesh position={[-hingeDirection * (spec.width - 0.05), 0, 0.02 + arcDepth]} castShadow>
        <boxGeometry args={[0.1, spec.height + 0.02, 0.08]} />
        <meshStandardMaterial {...doorWoodMaterialProps} roughness={0.82} />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, spec.height * 0.5 - 0.045, 0.02 + arcDepth]} castShadow>
        <boxGeometry args={[spec.width + 0.02, 0.1, 0.08]} />
        <meshStandardMaterial {...doorWoodMaterialProps} roughness={0.82} />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, -spec.height * 0.5 + 0.045, 0.02 + arcDepth]} castShadow>
        <boxGeometry args={[spec.width + 0.02, 0.1, 0.08]} />
        <meshStandardMaterial {...doorWoodMaterialProps} roughness={0.82} />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, 0, 0.068 + arcDepth]} renderOrder={16}>
        <boxGeometry args={[glassInsetWidth, glassInsetHeight, 0.012]} />
        <meshPhysicalMaterial
          color="#bdd1de"
          transparent
          opacity={0.34}
          roughness={0.08}
          metalness={0.08}
          transmission={0.72}
          ior={1.5}
          thickness={0.12}
          clearcoat={1}
          clearcoatRoughness={0.06}
          attenuationColor="#c9deea"
          attenuationDistance={0.9}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, 0.04, 0.076 + arcDepth]} renderOrder={17}>
        <planeGeometry args={[glassInsetWidth * 0.92, glassInsetHeight * 0.92]} />
        <meshBasicMaterial color="#f3fbff" transparent opacity={0.12} depthWrite={false} />
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
  modelUrl,
  spec,
  style,
  woodTexture,
  open,
  active,
  interactionLocked,
  onToggle,
}: {
  doorId: string;
  item: CabinetItem;
  modelUrl?: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  woodTexture?: Texture | null;
  open: boolean;
  active: boolean;
  interactionLocked: boolean;
  onToggle: (doorId: string) => void;
}) {
  const lockerDepth = style.depth * 0.8; // Adjusted for new depth
  const innerWidth = spec.width - 0.04;
  const innerHeight = spec.height - 0.04;
  const wallThickness = 0.035;
  const frontLipDepth = 0.08;
  const interiorWood = woodTexture
    ? style.wood
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
      {modelUrl ? (
        <ModelDisplay modelUrl={modelUrl} spec={spec} style={style} open={open} active={active} />
      ) : (
        <ItemDisplay
          item={item}
          spec={spec}
          style={style}
          open={open}
          active={active}
        />
      )}
      <ClickableFront
        doorId={doorId}
        spec={spec}
        style={style}
        open={open}
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
  openedDoorIds,
  focusedDoorId,
  allItems,
  doorItemIds,
  interactionLocked,
  woodTextures,
  onToggleDoor,
}: {
  group: CabinetGroup;
  index: number;
  totalGroups: number;
  placement: FurniturePlacement;
  openedDoorIds: Record<string, boolean>;
  focusedDoorId: string;
  allItems: CabinetItem[];
  doorItemIds: Record<string, string>;
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
    color: style.wood,
    roughness: 0.82,
    metalness: 0.08,
  };

  return (
    <group
      position={[placement.position[0], placement.position[1] + style.y, placement.position[2]]}
      rotation={[0, placement.rotationY, 0]}
    >
      <mesh position={[0, 0, -style.depth * 0.4]} receiveShadow castShadow>
        <boxGeometry args={[style.width * 1.0, style.height, 0.08]} />
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
              modelUrl={item.modelUrl}
              spec={spec}
              style={style}
              woodTexture={cabinetWoodTexture}
              open={Boolean(openedDoorIds[doorId])}
              active={focusedDoorId === doorId}
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
  openedDoorIds,
  focusedDoorId,
  doorItemIds,
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
  openedDoorIds: Record<string, boolean>;
  focusedDoorId: string;
  doorItemIds: Record<string, string>;
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
              openedDoorIds={openedDoorIds}
              focusedDoorId={focusedDoorId}
              allItems={allItems}
              doorItemIds={doorItemIds}
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
  // "/wood-surface.jpg",
  "/dark_wood.jpg",
  // "/light_wood.jpg",
  // "/medium_light_wood.jpg",
];

export function CabinetPanorama({ items }: CabinetPanoramaProps) {
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const groups = useMemo(() => chunkItems(items), [items]);
  const doorIds = useMemo(() => getDoorIdsForGroups(groups), [groups]);
  const placements = useMemo(() => getFurniturePlacements(groups), [groups]);
  const doorItemPools = useMemo(() => buildDoorItemPools(groups, items), [groups, items]);
  const initialDoorItemIds = useMemo(() => {
    const nextDoorItemIds: Record<string, string> = {};

    if (items.length === 0) {
      return nextDoorItemIds;
    }

    doorIds.forEach((doorId, index) => {
      const pool = doorItemPools[doorId] ?? [];
      nextDoorItemIds[doorId] = pool.length > 0
        ? pool[index % pool.length]
        : items[index % items.length]?.id ?? "";
    });

    return nextDoorItemIds;
  }, [doorIds, doorItemPools, items]);
  const [doorItemIds, setDoorItemIds] = useState<Record<string, string>>(() => initialDoorItemIds);
  const [seenItemIds, setSeenItemIds] = useState<Record<string, boolean>>({});
  const [selectedItemId, setSelectedItemId] = useState("");
  const [focusedDoorId, setFocusedDoorId] = useState("");
  const [openedDoorIds, setOpenedDoorIds] = useState<Record<string, boolean>>({});
  const [returnPose, setReturnPose] = useState<CameraPose | null>(null);
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

  useEffect(() => {
    setDoorItemIds((currentDoorItemIds) => {
      const nextDoorItemIds: Record<string, string> = {};

      doorIds.forEach((doorId, index) => {
        const pool = doorItemPools[doorId] ?? [];
        const existingItemId = currentDoorItemIds[doorId];

        nextDoorItemIds[doorId] =
          existingItemId && pool.includes(existingItemId)
            ? existingItemId
            : initialDoorItemIds[doorId] || items[index % items.length]?.id || "";
      });

      const currentDoorKeys = Object.keys(currentDoorItemIds);
      const nextDoorKeys = Object.keys(nextDoorItemIds);

      if (
        currentDoorKeys.length === nextDoorKeys.length &&
        nextDoorKeys.every((doorId) => currentDoorItemIds[doorId] === nextDoorItemIds[doorId])
      ) {
        return currentDoorItemIds;
      }

      return nextDoorItemIds;
    });
    setSeenItemIds({});
    setSelectedItemId("");
    setFocusedDoorId("");
    setOpenedDoorIds({});
    setReturnPose(null);
    setInteractionLocked(false);
  }, [doorIds, doorItemPools, initialDoorItemIds, items]);

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

  const toggleDoor = (doorId: string) => {
    if (interactionLocked && focusedDoorId !== doorId) {
      return;
    }

    if (items.length === 0) {
      return;
    }

    const pool = doorItemPools[doorId] ?? [];
    const currentItemId = doorItemIds[doorId];
    const preferredItemId = pool.length > 0
      ? chooseNextPoolItem(pool, currentItemId, seenItemIds, itemsById)
      : currentItemId;
    const resolvedItemId = !openedDoorIds[doorId] && preferredItemId
      ? preferredItemId
      : currentItemId;
    const currentItem =
      items.find((candidate) => candidate.id === resolvedItemId) ??
      items[hashSeed(doorId) % Math.max(items.length, 1)];

    if (!currentItem) {
      return;
    }

    if (!openedDoorIds[doorId]) {
      if (resolvedItemId && resolvedItemId !== currentItemId) {
        setDoorItemIds((currentDoorItemIds) => ({
          ...currentDoorItemIds,
          [doorId]: resolvedItemId,
        }));
      }
      setOpenedDoorIds((currentDoors) => ({ ...currentDoors, [doorId]: true }));
    }

    if (focusedDoorId === doorId) {
      setDoorItemIds((currentDoorItemIds) => {
        if (pool.length === 0) {
          return currentDoorItemIds;
        }

        const nextItemId = chooseNextPoolItem(pool, currentDoorItemIds[doorId], {
          ...seenItemIds,
          [currentDoorItemIds[doorId] ?? ""]: true,
        }, itemsById);

        if (!nextItemId || nextItemId === currentDoorItemIds[doorId]) {
          return currentDoorItemIds;
        }

        return {
          ...currentDoorItemIds,
          [doorId]: nextItemId,
        };
      });
      setOpenedDoorIds((currentDoors) => {
        if (!currentDoors[doorId]) {
          return currentDoors;
        }

        return { ...currentDoors, [doorId]: false };
      });
      setReturnPose(roamPoseRef.current);
      setFocusedDoorId("");
      setSelectedItemId("");
      return;
    }

    setSeenItemIds((currentSeenItemIds) => ({
      ...currentSeenItemIds,
      [currentItem.id]: true,
    }));

    if (openedDoorIds[doorId] && !focusedDoorId) {
      setSelectedItemId(currentItem.id);
      setFocusedDoorId(doorId);
      setReturnPose(null);
      return;
    }

    setSelectedItemId(currentItem.id);
    setFocusedDoorId(doorId);
    setReturnPose(null);
  };

  const handleRoamPoseChange = useCallback((pose: CameraPose) => {
    roamPoseRef.current = pose;
  }, []);

  const handleTargetReached = useCallback((mode: "focus" | "return") => {
    if (mode === "return") {
      setReturnPose(null);
      setInteractionLocked(false);
    }
  }, []);

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
                openedDoorIds={openedDoorIds}
                focusedDoorId={focusedDoorId}
                doorItemIds={doorItemIds}
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
