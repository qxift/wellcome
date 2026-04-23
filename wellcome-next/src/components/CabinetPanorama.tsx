"use client";

import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { DoubleSide, MathUtils, TextureLoader, type Group } from "three";
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

const playerRadius = 0.28;
const roomRadius = 5.2;
const furnitureRadius = 4.45;
const itemsPerCabinet = 4;
const doorsPerCabinet = 9;

function trimTitle(title: string) {
  return title.replace(/^\[/, "").replace(/\]\.?$/, "");
}

function hashSeed(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function pick<T>(values: T[], seed: number, offset = 0) {
  return values[(seed + offset) % values.length];
}

function chunkItems(items: CabinetItem[]): CabinetGroup[] {
  const groups: CabinetGroup[] = [];

  for (let index = 0; index < items.length; index += itemsPerCabinet) {
    const groupItems = items.slice(index, index + itemsPerCabinet);
    groups.push({
      id: groupItems.map((item) => item.id).join("-"),
      items: groupItems,
    });
  }

  return groups;
}

function getCabinetStyle(group: CabinetGroup, index: number): CabinetStyle {
  const seed = hashSeed(`${group.id}-${index}`);
  const woods = ["#3b1a0a", "#5a3217", "#2c1408", "#6c4727", "#49301b", "#271109"];
  const trims = ["#8a5a2b", "#4b2410", "#a0713a", "#2f170a", "#6a3d1e"];
  const furnitureType = pick(
    ["tall-cabinet", "bookcase", "vitrine-table", "sideboard", "wall-case"] as const,
    seed,
    index,
  );
  const dimensions = {
    "tall-cabinet": { width: 3.0, height: 3.55, depth: 0.82, y: 0 },
    bookcase: { width: 3.45, height: 3.25, depth: 0.62, y: 0 },
    "vitrine-table": { width: 3.1, height: 1.75, depth: 1.05, y: -0.68 },
    sideboard: { width: 3.55, height: 2.15, depth: 0.86, y: -0.38 },
    "wall-case": { width: 2.55, height: 2.25, depth: 0.48, y: 0.45 },
  }[furnitureType];

  return {
    width: dimensions.width + (seed % 4) * 0.12,
    height: dimensions.height + ((seed >> 3) % 4) * 0.1,
    depth: dimensions.depth + ((seed >> 6) % 3) * 0.06,
    y: dimensions.y + (((seed >> 9) % 5) - 2) * 0.04,
    wood: pick(woods, seed),
    trim: pick(trims, seed, 3),
    back: group.items[0]?.color ?? "#7b5732",
    crown: furnitureType === "vitrine-table" ? "flat" : pick(["flat", "stepped", "arch"], seed, 11),
    foot: pick(["block", "bun", "none"], seed, 17),
    furnitureType,
  };
}

function getCompartmentSpecs(style: CabinetStyle, count: number, seed: number): CompartmentSpec[] {
  const innerWidth = style.width - 0.42;
  const innerHeight = style.height - 0.56;
  const columns = seed % 2 === 0 ? 3 : 4;
  const rows = Math.ceil(count / columns);
  const gap = 0.075;
  const specs: CompartmentSpec[] = [];
  const columnWidths = Array.from({ length: columns }, (_, column) => {
    const wobble = ((seed >> (column * 3)) % 5 - 2) * 0.035;
    return innerWidth / columns + wobble;
  });
  const normalizedWidth = columnWidths.reduce((sum, width) => sum + width, 0) + gap * (columns - 1);
  const widthScale = innerWidth / normalizedWidth;
  const scaledWidths = columnWidths.map((width) => width * widthScale);
  const rowHeight = (innerHeight - gap * (rows - 1)) / rows;

  let cursorX = -innerWidth / 2;

  for (let column = 0; column < columns; column += 1) {
    const width = scaledWidths[column];

    for (let row = 0; row < rows; row += 1) {
      if (specs.length >= count) break;

      const heightWobble = ((seed >> (row * 4 + column)) % 5 - 2) * 0.025;
      const height = Math.max(0.34, rowHeight + heightWobble);
      const x = cursorX + width / 2;
      const y = innerHeight / 2 - rowHeight / 2 - row * (rowHeight + gap);

      specs.push({
        x,
        y,
        width,
        height,
        type: (row + column + seed) % 2 === 0 ? "door-left" : "door-right",
      });
    }

    cursorX += width + gap;
  }

  return specs;
}

function getFurniturePlacement(index: number) {
  const angle = index * 1.08 + 0.26;
  const radius = furnitureRadius + (index % 3 - 1) * 0.12;
  const x = Math.sin(angle) * radius;
  const z = -Math.cos(angle) * radius;

  return {
    position: [x, 0, z] as [number, number, number],
    rotationY: -angle,
  };
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

function getFurnitureBlockers(groups: CabinetGroup[]) {
  return groups.map((group, index) => {
    const style = getCabinetStyle(group, index);
    const placement = getFurniturePlacement(index);
    const facesSideWall = Math.abs(Math.sin(placement.rotationY)) > 0.7;
    const footprintWidth = facesSideWall ? style.depth : style.width;
    const footprintDepth = facesSideWall ? style.width : style.depth;

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

function RoomArchitecture() {
  const wallSegments = Array.from({ length: 28 }, (_, index) => {
    const angle = (index / 28) * Math.PI * 2;
    return {
      angle,
      x: Math.sin(angle) * roomRadius,
      z: -Math.cos(angle) * roomRadius,
    };
  });

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.92, 0]} receiveShadow>
        <circleGeometry args={[roomRadius, 96]} />
        <meshStandardMaterial color="#5a3217" roughness={0.86} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.35, -1.915, -0.25]}>
        <circleGeometry args={[1.55, 48]} />
        <meshStandardMaterial color="#7c1f18" roughness={0.92} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.35, -1.91, -0.25]}>
        <ringGeometry args={[1.28, 1.55, 48]} />
        <meshStandardMaterial color="#c49a54" roughness={0.8} />
      </mesh>

      {wallSegments.map((segment, index) => (
        <group key={`wall-${index}`} position={[segment.x, 0.15, segment.z]} rotation={[0, -segment.angle, 0]}>
          <mesh>
            <boxGeometry args={[1.35, 4.2, 0.16]} />
            <meshStandardMaterial color={index % 2 ? "#744a28" : "#6a4021"} roughness={0.92} />
          </mesh>
          <mesh position={[0, 0.62, -0.09]}>
            <boxGeometry args={[0.72, 0.5, 0.04]} />
            <meshStandardMaterial color={index % 3 ? "#2b170d" : "#3b2417"} roughness={0.82} />
          </mesh>
          <mesh position={[0, 0.62, -0.12]}>
            <boxGeometry args={[0.5, 0.32, 0.035]} />
            <meshStandardMaterial color={index % 2 ? "#9c6b34" : "#1f4a3a"} roughness={0.78} />
          </mesh>
          <mesh position={[0, -1.05, -0.1]}>
            <boxGeometry args={[1.1, 0.08, 0.05]} />
            <meshStandardMaterial color="#3b1a0a" roughness={0.76} />
          </mesh>
        </group>
      ))}

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

      <group position={[-1.9, -1.35, 1.55]}>
        <mesh position={[0, 0.55, 0]}>
          <cylinderGeometry args={[0.04, 0.05, 1.1, 8]} />
          <meshStandardMaterial color="#29492c" roughness={0.8} />
        </mesh>
        {[-0.45, -0.22, 0, 0.22, 0.45].map((leafAngle, index) => (
          <mesh key={`fern-${index}`} position={[Math.sin(leafAngle) * 0.28, 1.05 - index * 0.05, Math.cos(leafAngle) * 0.08]} rotation={[0.9, leafAngle, 0.25]}>
            <planeGeometry args={[0.18, 0.72]} />
            <meshStandardMaterial color="#52783c" roughness={0.86} side={DoubleSide} />
          </mesh>
        ))}
        <mesh position={[0, -0.05, 0]}>
          <cylinderGeometry args={[0.22, 0.28, 0.28, 12]} />
          <meshStandardMaterial color="#6a2f18" roughness={0.82} />
        </mesh>
      </group>

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
  onSelect,
}: {
  item: CabinetItem;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  onSelect: (item: CabinetItem) => void;
}) {
  const texture = useLoader(TextureLoader, item.imageUrl);
  const imageWidth = spec.width * 0.68;
  const imageHeight = spec.height * 0.58;
  const handleClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();

    if (open) {
      onSelect(item);
    }
  };

  return (
    <group position={[spec.x, spec.y, style.depth * 0.36]} onClick={handleClick}>
      <mesh position={[0, -spec.height * 0.36, -0.03]} receiveShadow>
        <boxGeometry args={[spec.width * 0.72, 0.08, style.depth * 0.52]} />
        <meshStandardMaterial color={style.trim} roughness={0.78} />
      </mesh>
      <mesh scale={open ? 1.06 : 1} visible={open}>
        <planeGeometry args={[imageWidth, imageHeight]} />
        <meshBasicMaterial map={texture} transparent side={DoubleSide} />
      </mesh>
    </group>
  );
}


function ClickableFront({
  doorId,
  spec,
  style,
  open,
  onToggle,
}: {
  doorId: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  onToggle: (doorId: string) => void;
}) {
  const frontRef = useRef<Group>(null);
  const frontZ = style.depth * 0.9;
  const hingeDirection = spec.type === "door-left" ? -1 : 1;
  const glassDoor = style.furnitureType === "vitrine-table" || style.furnitureType === "bookcase";

  useFrame((_, delta) => {
    if (!frontRef.current) return;

    frontRef.current.rotation.y = MathUtils.damp(
      frontRef.current.rotation.y,
      open ? hingeDirection * 1.35 : 0,
      7,
      delta,
    );
  });

  const handleClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onToggle(doorId);
  };

  return (
    <group
      ref={frontRef}
      position={[spec.x + hingeDirection * spec.width * 0.5, spec.y, frontZ]}
      onClick={handleClick}
    >
      <mesh position={[-hingeDirection * spec.width * 0.5, 0, 0]} castShadow>
        <boxGeometry args={[spec.width + 0.1, spec.height + 0.1, 0.12]} />
        <meshStandardMaterial color={style.trim} roughness={0.74} metalness={0.04} />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, 0, 0.075]}>
        <boxGeometry args={[spec.width - 0.12, spec.height - 0.18, 0.04]} />
        {glassDoor ? (
          <meshPhysicalMaterial
            color="#d8f2ff"
            transparent
            opacity={0.24}
            roughness={0.04}
            transmission={0.35}
          />
        ) : (
          <meshStandardMaterial color={style.wood} roughness={0.82} />
        )}
      </mesh>
      {glassDoor ? (
        <>
          <mesh position={[-hingeDirection * spec.width * 0.5, 0, 0.13]}>
            <boxGeometry args={[0.035, spec.height - 0.12, 0.04]} />
            <meshStandardMaterial color={style.trim} roughness={0.72} />
          </mesh>
          <mesh position={[-hingeDirection * spec.width * 0.5, 0, 0.14]}>
            <boxGeometry args={[spec.width - 0.12, 0.035, 0.04]} />
            <meshStandardMaterial color={style.trim} roughness={0.72} />
          </mesh>
          <mesh position={[-hingeDirection * spec.width * 0.74, 0, 0.145]}>
            <boxGeometry args={[0.025, spec.height - 0.22, 0.035]} />
            <meshStandardMaterial color="#d3a95f" roughness={0.34} metalness={0.62} />
          </mesh>
          <mesh position={[-hingeDirection * spec.width * 0.26, 0, 0.145]}>
            <boxGeometry args={[0.025, spec.height - 0.22, 0.035]} />
            <meshStandardMaterial color="#d3a95f" roughness={0.34} metalness={0.62} />
          </mesh>
        </>
      ) : (
        <>
          <mesh position={[-hingeDirection * spec.width * 0.5, spec.height * 0.27, 0.13]}>
            <boxGeometry args={[spec.width - 0.24, 0.04, 0.035]} />
            <meshStandardMaterial color="#d3a95f" roughness={0.34} metalness={0.62} />
          </mesh>
          <mesh position={[-hingeDirection * spec.width * 0.5, -spec.height * 0.27, 0.13]}>
            <boxGeometry args={[spec.width - 0.24, 0.04, 0.035]} />
            <meshStandardMaterial color="#d3a95f" roughness={0.34} metalness={0.62} />
          </mesh>
          {[-0.38, 0.38].map((xOffset) => (
            <mesh key={xOffset} position={[-hingeDirection * spec.width * (0.5 + xOffset), spec.height * 0.42, 0.135]}>
              <sphereGeometry args={[0.025, 10, 10]} />
              <meshStandardMaterial color="#d3a95f" roughness={0.34} metalness={0.62} />
            </mesh>
          ))}
        </>
      )}
      <mesh position={[-hingeDirection * spec.width * 0.86, -spec.height * 0.18, 0.16]}>
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
  open,
  onToggle,
  onSelect,
}: {
  doorId: string;
  item: CabinetItem;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  onToggle: (doorId: string) => void;
  onSelect: (item: CabinetItem) => void;
}) {
  return (
    <>
      <mesh position={[spec.x, spec.y, style.depth * 0.28]}>
        <boxGeometry args={[spec.width - 0.08, spec.height - 0.08, 0.08]} />
        <meshStandardMaterial color={item.color || style.back} roughness={0.72} />
      </mesh>
      <ItemDisplay item={item} spec={spec} style={style} open={open} onSelect={onSelect} />
      <ClickableFront doorId={doorId} spec={spec} style={style} open={open} onToggle={onToggle} />
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
}: {
  group: CabinetGroup;
  style: CabinetStyle;
  seed: number;
}) {
  const brass = "#d3a95f";
  const frontZ = style.depth * 0.88;
  const topY = style.height * 0.58;

  return (
    <group>
      {style.furnitureType === "sideboard" ? (
        <group position={[0, style.height * 0.36, frontZ + 0.03]}>
          {Array.from({ length: 10 }, (_, drawerIndex) => {
            const column = drawerIndex % 5;
            const row = Math.floor(drawerIndex / 5);
            return (
              <group
                key={`drawer-front-${group.id}-${drawerIndex}`}
                position={[-style.width * 0.34 + column * style.width * 0.17, -row * 0.34, 0]}
              >
                <mesh>
                  <boxGeometry args={[0.42, 0.22, 0.045]} />
                  <meshStandardMaterial color={style.wood} roughness={0.82} />
                </mesh>
                <mesh position={[0, 0, 0.04]}>
                  <boxGeometry args={[0.16, 0.035, 0.04]} />
                  <meshStandardMaterial color={brass} roughness={0.3} metalness={0.7} />
                </mesh>
              </group>
            );
          })}
        </group>
      ) : null}

      {style.furnitureType === "vitrine-table" ? (
        <>
          <mesh position={[0, style.height * 0.18, frontZ + 0.03]}>
            <boxGeometry args={[style.width * 0.92, style.height * 0.62, 0.035]} />
            <meshPhysicalMaterial
              color="#d8f2ff"
              transparent
              opacity={0.16}
              roughness={0.02}
              transmission={0.45}
            />
          </mesh>
          <SpecimenDome x={-style.width * 0.28} y={topY + 0.18} z={0.08} accent={group.items[0]?.color ?? brass} />
          <mesh position={[style.width * 0.28, topY + 0.12, 0.08]} rotation={[0.25, 0, 0.2]}>
            <boxGeometry args={[0.54, 0.12, 0.34]} />
            <meshStandardMaterial color="#5f4329" roughness={0.84} />
          </mesh>
        </>
      ) : null}

      {style.furnitureType === "bookcase" ? (
        <>
          {[-0.9, -0.62, -0.34, -0.06, 0.22, 0.5, 0.78].map((bookX, bookIndex) => (
            <mesh
              key={`upper-book-${group.id}-${bookIndex}`}
              position={[bookX, topY + 0.02, frontZ - 0.02]}
              rotation={[0, 0, (bookIndex % 3 - 1) * 0.05]}
            >
              <boxGeometry args={[0.16, 0.72 + (bookIndex % 2) * 0.14, 0.16]} />
              <meshStandardMaterial color={bookIndex % 2 ? "#2f4a36" : "#9c6b34"} roughness={0.82} />
            </mesh>
          ))}
          <SpecimenDome x={style.width * 0.34} y={topY - 0.02} z={frontZ - 0.02} accent={brass} />
        </>
      ) : null}

      {style.furnitureType === "wall-case" ? (
        <>
          <mesh position={[0, topY + 0.24, 0.02]} rotation={[0, 0, 0]}>
            <torusGeometry args={[style.width * 0.28, 0.035, 12, 36, Math.PI]} />
            <meshStandardMaterial color={style.trim} roughness={0.68} />
          </mesh>
          <mesh position={[-style.width * 0.35, -style.height * 0.55, frontZ]}>
            <coneGeometry args={[0.12, 0.48, 5]} />
            <meshStandardMaterial color={brass} roughness={0.32} metalness={0.62} />
          </mesh>
          <mesh position={[style.width * 0.35, -style.height * 0.55, frontZ]}>
            <coneGeometry args={[0.12, 0.48, 5]} />
            <meshStandardMaterial color={brass} roughness={0.32} metalness={0.62} />
          </mesh>
        </>
      ) : null}

      {style.furnitureType === "tall-cabinet" ? (
        <>
          <SpecimenDome x={-style.width * 0.28} y={topY + 0.12} z={0.08} accent={group.items[1]?.color ?? brass} />
          <mesh position={[style.width * 0.28, topY + 0.2, 0.08]} rotation={[0.2, 0.4, 0]}>
            <sphereGeometry args={[0.18 + (seed % 3) * 0.03, 18, 18]} />
            <meshStandardMaterial color="#f1dfbd" roughness={0.62} />
          </mesh>
          <mesh position={[style.width * 0.28, topY, 0.08]}>
            <cylinderGeometry args={[0.05, 0.07, 0.36, 10]} />
            <meshStandardMaterial color={style.trim} roughness={0.72} />
          </mesh>
        </>
      ) : null}

      <mesh position={[0, -style.height * 0.48, frontZ + 0.04]}>
        <boxGeometry args={[style.width * 0.62, 0.045, 0.035]} />
        <meshStandardMaterial color={brass} roughness={0.35} metalness={0.65} />
      </mesh>
    </group>
  );
}

function CabinetPanel({
  group,
  index,
  allItems,
  openedDoorIds,
  doorItemIds,
  onToggleDoor,
  onSelectItem,
}: {
  group: CabinetGroup;
  index: number;
  allItems: CabinetItem[];
  openedDoorIds: Set<string>;
  doorItemIds: Record<string, string>;
  onToggleDoor: (doorId: string) => void;
  onSelectItem: (item: CabinetItem) => void;
}) {
  const style = getCabinetStyle(group, index);
  const seed = hashSeed(`${group.id}-${index}-layout`);
  const specs = getCompartmentSpecs(style, doorsPerCabinet, seed);
  const placement = getFurniturePlacement(index);

  return (
    <group
      position={[placement.position[0], placement.position[1] + style.y, placement.position[2]]}
      rotation={[0, placement.rotationY, 0]}
    >
      <mesh position={[0, 0, -style.depth * 0.28]} receiveShadow castShadow>
        <boxGeometry args={[style.width, style.height, style.depth]} />
        <meshStandardMaterial color={style.wood} roughness={0.82} metalness={0.08} />
      </mesh>

      <mesh position={[0, style.height * 0.52, 0.1]} castShadow>
        <boxGeometry args={[style.width + 0.26, 0.16, style.depth + 0.18]} />
        <meshStandardMaterial color={style.trim} roughness={0.7} />
      </mesh>
      <mesh position={[0, -style.height * 0.52, 0.1]} castShadow>
        <boxGeometry args={[style.width + 0.26, 0.16, style.depth + 0.18]} />
        <meshStandardMaterial color={style.trim} roughness={0.7} />
      </mesh>
      <mesh position={[-style.width * 0.52, 0, 0.1]} castShadow>
        <boxGeometry args={[0.16, style.height + 0.28, style.depth + 0.18]} />
        <meshStandardMaterial color={style.trim} roughness={0.7} />
      </mesh>
      <mesh position={[style.width * 0.52, 0, 0.1]} castShadow>
        <boxGeometry args={[0.16, style.height + 0.28, style.depth + 0.18]} />
        <meshStandardMaterial color={style.trim} roughness={0.7} />
      </mesh>

      {specs.map((spec, specIndex) => {
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
            open={openedDoorIds.has(doorId)}
            onToggle={onToggleDoor}
            onSelect={onSelectItem}
          />
        );
      })}

      {specs.map((spec, specIndex) => (
        <group key={`trim-${group.id}-${specIndex}`} position={[spec.x, spec.y, style.depth * 0.82]}>
          <mesh position={[0, spec.height * 0.5, 0]}>
            <boxGeometry args={[spec.width + 0.1, 0.045, 0.055]} />
            <meshStandardMaterial color={style.trim} roughness={0.76} />
          </mesh>
          <mesh position={[0, -spec.height * 0.5, 0]}>
            <boxGeometry args={[spec.width + 0.1, 0.045, 0.055]} />
            <meshStandardMaterial color={style.trim} roughness={0.76} />
          </mesh>
          <mesh position={[-spec.width * 0.5, 0, 0]}>
            <boxGeometry args={[0.045, spec.height + 0.1, 0.055]} />
            <meshStandardMaterial color={style.trim} roughness={0.76} />
          </mesh>
          <mesh position={[spec.width * 0.5, 0, 0]}>
            <boxGeometry args={[0.045, spec.height + 0.1, 0.055]} />
            <meshStandardMaterial color={style.trim} roughness={0.76} />
          </mesh>
        </group>
      ))}

      {Array.from({ length: 18 }, (_, studIndex) => {
        const side = studIndex % 2 === 0 ? -1 : 1;
        const row = Math.floor(studIndex / 2);
        return (
          <mesh
            key={`stud-${group.id}-${studIndex}`}
            position={[side * style.width * 0.49, -style.height * 0.42 + row * style.height * 0.105, style.depth * 0.9]}
          >
            <sphereGeometry args={[0.025, 10, 10]} />
            <meshStandardMaterial color="#d3a95f" roughness={0.35} metalness={0.66} />
          </mesh>
        );
      })}

      {[-0.34, 0, 0.34].map((railY) => (
        <mesh key={`rail-${group.id}-${railY}`} position={[0, railY * style.height, style.depth * 0.93]}>
          <boxGeometry args={[style.width * 0.92, 0.025, 0.04]} />
          <meshStandardMaterial color="#d3a95f" roughness={0.35} metalness={0.66} />
        </mesh>
      ))}

      {style.crown === "stepped" ? (
        <>
          <mesh position={[0, style.height * 0.59, 0.03]} castShadow>
            <boxGeometry args={[style.width * 0.8, 0.14, style.depth * 0.74]} />
            <meshStandardMaterial color={style.trim} roughness={0.7} />
          </mesh>
          <mesh position={[0, style.height * 0.65, 0.03]} castShadow>
            <boxGeometry args={[style.width * 0.56, 0.12, style.depth * 0.58]} />
            <meshStandardMaterial color={style.trim} roughness={0.7} />
          </mesh>
        </>
      ) : null}

      {style.crown === "arch" ? (
        <mesh position={[0, style.height * 0.58, 0.03]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[style.depth * 0.42, style.depth * 0.42, style.width * 0.76, 24, 1, true]} />
          <meshStandardMaterial color={style.trim} roughness={0.72} side={DoubleSide} />
        </mesh>
      ) : null}

      {style.foot === "block" ? (
        <>
          <mesh position={[-style.width * 0.35, -style.height * 0.58, 0.18]} castShadow>
            <boxGeometry args={[0.28, 0.18, style.depth * 0.62]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
          <mesh position={[style.width * 0.35, -style.height * 0.58, 0.18]} castShadow>
            <boxGeometry args={[0.28, 0.18, style.depth * 0.62]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
        </>
      ) : null}

      {style.foot === "bun" ? (
        <>
          <mesh position={[-style.width * 0.34, -style.height * 0.57, 0.18]} castShadow>
            <sphereGeometry args={[0.14, 18, 18]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
          <mesh position={[style.width * 0.34, -style.height * 0.57, 0.18]} castShadow>
            <sphereGeometry args={[0.14, 18, 18]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
        </>
      ) : null}

      {style.furnitureType === "vitrine-table" ? (
        <>
          <mesh position={[-style.width * 0.38, -style.height * 0.72, style.depth * 0.18]} castShadow>
            <cylinderGeometry args={[0.055, 0.075, 1.05, 12]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
          <mesh position={[style.width * 0.38, -style.height * 0.72, style.depth * 0.18]} castShadow>
            <cylinderGeometry args={[0.055, 0.075, 1.05, 12]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
          <mesh position={[-style.width * 0.38, -style.height * 0.72, -style.depth * 0.46]} castShadow>
            <cylinderGeometry args={[0.055, 0.075, 1.05, 12]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
          <mesh position={[style.width * 0.38, -style.height * 0.72, -style.depth * 0.46]} castShadow>
            <cylinderGeometry args={[0.055, 0.075, 1.05, 12]} />
            <meshStandardMaterial color={style.trim} roughness={0.78} />
          </mesh>
        </>
      ) : null}

      {style.furnitureType === "bookcase" ? (
        <>
          {[-0.8, -0.45, -0.1, 0.25, 0.6, 0.95].map((bookX, bookIndex) => (
            <mesh
              key={`book-${group.id}-${bookIndex}`}
              position={[bookX, style.height * 0.46, style.depth * 0.6]}
              rotation={[0, 0, (bookIndex % 3 - 1) * 0.04]}
            >
              <boxGeometry args={[0.14, 0.62 + (bookIndex % 2) * 0.12, 0.18]} />
              <meshStandardMaterial color={bookIndex % 2 ? "#8f2f1d" : "#c19a54"} roughness={0.8} />
            </mesh>
          ))}
        </>
      ) : null}

      <AntiqueAdornment group={group} style={style} seed={seed} />
    </group>
  );
}

function WasdCamera({ blockers }: { blockers: FloorRect[] }) {
  const { camera } = useThree();
  const cameraRef = useRef(camera);
  const keys = useRef<Record<string, boolean>>({});
  const yaw = useRef(0);

  useEffect(() => {
    cameraRef.current = camera;
    cameraRef.current.position.set(0, 0.05, 0.25);
    cameraRef.current.rotation.set(0, 0, 0);
  }, [camera]);

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

  useFrame((_, delta) => {
    const sceneCamera = cameraRef.current;
    const turnSpeed = 1.85;
    const walkSpeed = 2.05;
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
  });

  return null;
}

function CabinetRoom({
  allItems,
  groups,
  openedDoorIds,
  doorItemIds,
  onToggleDoor,
  onSelectItem,
}: {
  allItems: CabinetItem[];
  groups: CabinetGroup[];
  openedDoorIds: Set<string>;
  doorItemIds: Record<string, string>;
  onToggleDoor: (doorId: string) => void;
  onSelectItem: (item: CabinetItem) => void;
}) {
  const blockers = useMemo(() => getFurnitureBlockers(groups), [groups]);

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

      <RoomArchitecture />
      <WasdCamera blockers={blockers} />

      <group>
        {groups.map((group, index) => (
          <CabinetPanel
            key={group.id}
            group={group}
            index={index}
            allItems={allItems}
            openedDoorIds={openedDoorIds}
            doorItemIds={doorItemIds}
            onToggleDoor={onToggleDoor}
            onSelectItem={onSelectItem}
          />
        ))}
      </group>
    </>
  );
}

export function CabinetPanorama({ items }: CabinetPanoramaProps) {
  const groups = useMemo(() => chunkItems(items), [items]);
  const [openedDoorIds, setOpenedDoorIds] = useState<Set<string>>(() => new Set());
  const [doorItemIds, setDoorItemIds] = useState<Record<string, string>>({});
  const [doorOpenCounts, setDoorOpenCounts] = useState<Record<string, number>>({});
  const [selectedItemId, setSelectedItemId] = useState("");
  const selectedItem = items.find((item) => item.id === selectedItemId);

  const toggleDoor = (doorId: string) => {
    const opening = !openedDoorIds.has(doorId);

    if (opening && items.length > 0) {
      const nextCount = (doorOpenCounts[doorId] ?? 0) + 1;
      const nextItem = items[(hashSeed(doorId) + nextCount * 7) % items.length];

      setDoorOpenCounts((current) => ({ ...current, [doorId]: nextCount }));
      setDoorItemIds((current) => ({ ...current, [doorId]: nextItem.id }));
      setSelectedItemId("");
    }

    setOpenedDoorIds((current) => {
      const next = new Set(current);

      if (next.has(doorId)) {
        next.delete(doorId);
      } else {
        next.add(doorId);
      }

      return next;
    });
  };

  const selectItem = (item: CabinetItem) => {
    setSelectedItemId(item.id);
  };

  return (
    <section className="panorama-shell" aria-label="Cabinet of curiosities panorama">
      <div className="panorama-stage">
        <Canvas
          camera={{ position: [0, 0.05, 0.25], fov: 72, near: 0.1, far: 40 }}
          shadows
          gl={{ antialias: true, alpha: false }}
        >
          <Suspense fallback={null}>
            <CabinetRoom
              allItems={items}
              groups={groups}
              openedDoorIds={openedDoorIds}
              doorItemIds={doorItemIds}
              onToggleDoor={toggleDoor}
              onSelectItem={selectItem}
            />
          </Suspense>
        </Canvas>

        <div className="panorama-vignette" />
        <div className="panorama-copy">
          <p>Wellcome cabinet prototype</p>
          <span>Use W/S to walk, A/D to turn. Click a door, then click the item inside.</span>
        </div>

        <div className="movement-hint" aria-label="Movement controls">
          <span>W</span>
          <span>A</span>
          <span>S</span>
          <span>D</span>
          <p>click doors</p>
        </div>

        {selectedItem ? (
          <aside className="active-caption">
            <p>{selectedItem.theme}</p>
            <h2>{trimTitle(selectedItem.title)}</h2>
            {selectedItem.year ? <span>{selectedItem.year}</span> : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
