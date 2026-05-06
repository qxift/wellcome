"use client";

import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box3,
  CanvasTexture,
  DoubleSide,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
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

type DissolvePhase = "idle" | "entering" | "exiting";

const playerRadius = 0.28;
const roomRadius = 4.385;
const itemsPerCabinet = 8;
const doorsPerCabinet = 8;
const cabinetsPerRow = 9;
const backgroundSeedTolerance = 42;
const backgroundFloodTolerance = 54;
const backgroundNeighborTolerance = 34;
const alphaVisibilityThreshold = 24;

function trimTitle(title: string) {
  return title.replace(/^\[/, "").replace(/\]\.?$/, "");
}

function cleanYear(year: string) {
  return year.replace(/^\[/, "").replace(/\]$/, "");
}

function buildDisplayTexture(sourceTexture: Texture) {
  const source = sourceTexture.image as
    | { width?: number; height?: number }
    | HTMLImageElement
    | HTMLCanvasElement
    | undefined;

  const width = source?.width ?? 0;
  const height = source?.height ?? 0;

  if (typeof document === "undefined" || width === 0 || height === 0) {
    const nextTexture = sourceTexture.clone();
    nextTexture.colorSpace = SRGBColorSpace;
    nextTexture.needsUpdate = true;
    return {
      texture: nextTexture,
      contentWidth: width || 1,
      contentHeight: height || 1,
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    const nextTexture = sourceTexture.clone();
    nextTexture.colorSpace = SRGBColorSpace;
    nextTexture.needsUpdate = true;
    return {
      texture: nextTexture,
      contentWidth: width,
      contentHeight: height,
    };
  }

  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  let edgeRedTotal = 0;
  let edgeGreenTotal = 0;
  let edgeBlueTotal = 0;
  let edgeSampleCount = 0;

  for (let x = 0; x < width; x += 1) {
    const topIndex = x * 4;
    const bottomIndex = ((height - 1) * width + x) * 4;
    edgeRedTotal += data[topIndex] + data[bottomIndex];
    edgeGreenTotal += data[topIndex + 1] + data[bottomIndex + 1];
    edgeBlueTotal += data[topIndex + 2] + data[bottomIndex + 2];
    edgeSampleCount += 2;
  }

  for (let y = 1; y < height - 1; y += 1) {
    const leftIndex = (y * width) * 4;
    const rightIndex = (y * width + (width - 1)) * 4;
    edgeRedTotal += data[leftIndex] + data[rightIndex];
    edgeGreenTotal += data[leftIndex + 1] + data[rightIndex + 1];
    edgeBlueTotal += data[leftIndex + 2] + data[rightIndex + 2];
    edgeSampleCount += 2;
  }

  const backgroundRed = edgeSampleCount > 0 ? edgeRedTotal / edgeSampleCount : 255;
  const backgroundGreen = edgeSampleCount > 0 ? edgeGreenTotal / edgeSampleCount : 255;
  const backgroundBlue = edgeSampleCount > 0 ? edgeBlueTotal / edgeSampleCount : 255;
  const backgroundMask = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let queueHead = 0;
  let queueTail = 0;

  const colorDistance = (leftRed: number, leftGreen: number, leftBlue: number, rightRed: number, rightGreen: number, rightBlue: number) =>
    Math.sqrt(
      (leftRed - rightRed) ** 2 +
      (leftGreen - rightGreen) ** 2 +
      (leftBlue - rightBlue) ** 2,
    );

  const enqueueBackgroundPixel = (x: number, y: number) => {
    const pixelIndex = y * width + x;

    if (backgroundMask[pixelIndex]) {
      return;
    }

    const dataIndex = pixelIndex * 4;
    const red = data[dataIndex];
    const green = data[dataIndex + 1];
    const blue = data[dataIndex + 2];
    const seedDistance = colorDistance(red, green, blue, backgroundRed, backgroundGreen, backgroundBlue);

    if (seedDistance > backgroundSeedTolerance) {
      return;
    }

    backgroundMask[pixelIndex] = 1;
    queue[queueTail] = pixelIndex;
    queueTail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueueBackgroundPixel(x, 0);
    enqueueBackgroundPixel(x, height - 1);
  }

  for (let y = 1; y < height - 1; y += 1) {
    enqueueBackgroundPixel(0, y);
    enqueueBackgroundPixel(width - 1, y);
  }

  while (queueHead < queueTail) {
    const pixelIndex = queue[queueHead];
    queueHead += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const dataIndex = pixelIndex * 4;
    const red = data[dataIndex];
    const green = data[dataIndex + 1];
    const blue = data[dataIndex + 2];

    const tryNeighbor = (nextX: number, nextY: number) => {
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
        return;
      }

      const neighborPixelIndex = nextY * width + nextX;

      if (backgroundMask[neighborPixelIndex]) {
        return;
      }

      const neighborDataIndex = neighborPixelIndex * 4;
      const neighborRed = data[neighborDataIndex];
      const neighborGreen = data[neighborDataIndex + 1];
      const neighborBlue = data[neighborDataIndex + 2];
      const distanceFromBackground = colorDistance(
        neighborRed,
        neighborGreen,
        neighborBlue,
        backgroundRed,
        backgroundGreen,
        backgroundBlue,
      );
      const distanceFromCurrent = colorDistance(
        neighborRed,
        neighborGreen,
        neighborBlue,
        red,
        green,
        blue,
      );

      if (
        distanceFromBackground <= backgroundFloodTolerance &&
        distanceFromCurrent <= backgroundNeighborTolerance
      ) {
        backgroundMask[neighborPixelIndex] = 1;
        queue[queueTail] = neighborPixelIndex;
        queueTail += 1;
      }
    };

    tryNeighbor(x - 1, y);
    tryNeighbor(x + 1, y);
    tryNeighbor(x, y - 1);
    tryNeighbor(x, y + 1);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < data.length; index += 4) {
    const pixelIndex = index / 4;

    if (backgroundMask[pixelIndex]) {
      data[index + 3] = 0;
    }

    if (data[index + 3] < alphaVisibilityThreshold) {
      data[index + 3] = 0;
    }

    if (data[index + 3] > 8) {
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  context.putImageData(imageData, 0, 0);
  const hasVisiblePixels = maxX >= minX && maxY >= minY;
  const cropX = hasVisiblePixels ? minX : 0;
  const cropY = hasVisiblePixels ? minY : 0;
  const cropWidth = hasVisiblePixels ? maxX - minX + 1 : width;
  const cropHeight = hasVisiblePixels ? maxY - minY + 1 : height;
  const croppedCanvas = document.createElement("canvas");
  croppedCanvas.width = cropWidth;
  croppedCanvas.height = cropHeight;
  const croppedContext = croppedCanvas.getContext("2d");

  if (croppedContext) {
    croppedContext.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  }

  const nextTexture = new CanvasTexture(croppedCanvas);
  nextTexture.colorSpace = SRGBColorSpace;
  nextTexture.needsUpdate = true;
  return {
    texture: nextTexture,
    contentWidth: cropWidth,
    contentHeight: cropHeight,
  };
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

function getUnifiedCabinetWidth() {
  return 3;
}

function getCabinetStyle(): CabinetStyle {
  return {
    width: getUnifiedCabinetWidth(),
    height: 4.02,
    depth: 1.2, // Increased depth to ensure full wall coverage
    y: 0,
    wood: "#4a2b1a",
    woodTextureIndex: 0,
  };
}

function getCompartmentSpecs(style: CabinetStyle, count: number): CompartmentSpec[] {
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
  return groups.flatMap((group) => {
    const style = getCabinetStyle();
    const specs = getCompartmentSpecs(style, doorsPerCabinet);

    return specs.map((_, specIndex) => `${group.id}-${specIndex}`);
  });
}

function buildDoorItemPools(groups: CabinetGroup[], items: CabinetItem[]) {
  return Object.fromEntries(
    groups.flatMap((group) => {
      const style = getCabinetStyle();
      const specs = getCompartmentSpecs(style, doorsPerCabinet);
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
  boardItemIds: string[],
) {
  if (pool.length === 0) {
    return "";
  }

  const boardKeywordCounts = new Map<string, number>();

  for (const itemId of boardItemIds) {
    const item = itemsById.get(itemId);

    for (const keyword of item?.linkKeywords ?? []) {
      boardKeywordCounts.set(keyword, (boardKeywordCounts.get(keyword) ?? 0) + 1);
    }
  }

  const isAlreadyOnBoard = (itemId: string) => boardItemIds.includes(itemId);
  const addsUniqueBoardKeyword = (itemId: string) =>
    (itemsById.get(itemId)?.linkKeywords ?? []).some((keyword) => !boardKeywordCounts.has(keyword));

  const unseen3dItemId = pool.find((itemId) => {
    if (seenItemIds[itemId] || isAlreadyOnBoard(itemId)) {
      return false;
    }

    return Boolean(itemsById.get(itemId)?.modelUrl);
  });
  if (unseen3dItemId) {
    return unseen3dItemId;
  }

  const unseenUniqueKeywordItemId = pool.find((itemId) => {
    if (seenItemIds[itemId] || isAlreadyOnBoard(itemId)) {
      return false;
    }

    return addsUniqueBoardKeyword(itemId);
  });
  if (unseenUniqueKeywordItemId) {
    return unseenUniqueKeywordItemId;
  }

  const unseenItemId = pool.find((itemId) => !seenItemIds[itemId] && !isAlreadyOnBoard(itemId));
  if (unseenItemId) {
    return unseenItemId;
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

function chooseInitialDoorItem(
  items: CabinetItem[],
  assignedItemIds: Set<string>,
) {
  const nextItemId = items.find((item) => !assignedItemIds.has(item.id))?.id ?? "";

  if (nextItemId) {
    assignedItemIds.add(nextItemId);
  }

  return nextItemId;
}

function isDemoModelDoor(
  doorId: string,
  doorItemIds: Record<string, string>,
  itemsById: Map<string, CabinetItem>,
) {
  if (!doorId) {
    return false;
  }

  const itemId = doorItemIds[doorId];

  if (!itemId) {
    return false;
  }

  return Boolean(itemsById.get(itemId)?.modelUrl);
}

function getFurniturePlacements(groups: CabinetGroup[]): FurniturePlacement[] {
  if (groups.length === 0) {
    return [];
  }

  const styles = groups.map(() => getCabinetStyle());
  const footprints = styles.map((style) => getCabinetOuterFootprint(style));
  const radius = roomRadius; // Position cabinets at the wall radius
  const spans = footprints.map((footprint) => {
    const chord = footprint.width;
    return 2 * Math.asin(Math.min(1, chord / (2 * radius)));
  });
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
): FocusTarget | null {
  const style = getCabinetStyle();
  const specs = getCompartmentSpecs(style, doorsPerCabinet);
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
    const style = getCabinetStyle();
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
  rugTexture,
  floorTexture,
}: {
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
        <meshStandardMaterial color="#ffe6a6" emissive="#f0a42f" emissiveIntensity={2.1} />
      </mesh>
      <pointLight position={[0, 1.8, 0]} intensity={5.2} color="#ffcc58" distance={7.5} />

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
              <meshPhysicalMaterial color="#ffe09a" transparent opacity={0.72} roughness={0.12} transmission={0.18} />
            </mesh>
          </group>
        );
      })}

      {[0.9, 2.7, 4.5].map((angle, index) => (
        <group key={`lamp-${index}`} position={[Math.sin(angle) * 2.8, 1.7, -Math.cos(angle) * 2.8]}>
          <sphereGeometry args={[0.1, 20, 20]} />
          <meshStandardMaterial color="#ffe09a" emissive="#e29a2a" emissiveIntensity={1.45} />
          <pointLight intensity={2.4} color="#ffca63" distance={4.8} />
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
  dissolvePhase,
}: {
  item: CabinetItem;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  active: boolean;
  dissolvePhase: DissolvePhase;
}) {
  const objectRef = useRef<Group>(null);
  const materialRef = useRef<MeshBasicMaterial | null>(null);
  const dissolveProgressRef = useRef(0);
  const texture = useLoader(TextureLoader, item.imageUrl, (loader) => {
    loader.crossOrigin = "anonymous";
  });
  const { texture: displayTexture, contentWidth, contentHeight } = useMemo(() => buildDisplayTexture(texture), [texture]);
  const { imageWidth, imageHeight } = useMemo(() => {
    const maxWidth = spec.width * 0.68;
    const maxHeight = spec.height * 0.58;
    const sourceWidth = contentWidth;
    const sourceHeight = contentHeight;
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
  }, [contentHeight, contentWidth, spec.height, spec.width]);

  useEffect(() => {
    dissolveProgressRef.current = dissolvePhase === "exiting" ? 1 : dissolvePhase === "entering" ? 0 : 1;
  }, [dissolvePhase, item.id]);

  useFrame((state, delta) => {
    if (!objectRef.current) return;

    const targetFloatY = active ? Math.sin(state.clock.elapsedTime * 1.3) * 0.012 : 0;
    const targetRotationY = active ? Math.sin(state.clock.elapsedTime * 0.7) * 0.08 : 0;
    const targetDissolve = dissolvePhase === "exiting" ? 0 : 1;
    dissolveProgressRef.current = MathUtils.damp(dissolveProgressRef.current, targetDissolve, 5.5, delta);
    const dissolve = dissolveProgressRef.current;

    objectRef.current.position.y = MathUtils.damp(objectRef.current.position.y, targetFloatY, 4, delta);
    objectRef.current.rotation.y = MathUtils.damp(objectRef.current.rotation.y, targetRotationY, 4, delta);
    objectRef.current.rotation.x = MathUtils.damp(objectRef.current.rotation.x, active ? -0.04 : 0, 4, delta);
    objectRef.current.position.z = MathUtils.damp(objectRef.current.position.z, (1 - dissolve) * -0.08, 6, delta);
    const scale = (open ? 1.04 : 1) * (0.94 + dissolve * 0.1);
    objectRef.current.scale.setScalar(scale);

    if (materialRef.current) {
      materialRef.current.opacity = dissolve * 0.9;
    }
  });

  const displayZ = open ? style.depth * 0.38 : style.depth * 0.1;
  const displayY = spec.y - spec.height * 0.04;

  return (
    <group position={[spec.x, displayY, displayZ]} renderOrder={11}>
      <group ref={objectRef}>
        <mesh position={[0, 0, 0.002]} renderOrder={12}>
          <planeGeometry args={[imageWidth, imageHeight]} />
          <meshBasicMaterial
            ref={materialRef}
            map={displayTexture}
            color="#dbc7a3"
            transparent
            side={DoubleSide}
            opacity={0}
          />
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
  dissolvePhase,
}: {
  modelUrl: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  active: boolean;
  dissolvePhase: DissolvePhase;
}) {
  const gltf = useLoader(GLTFLoader, modelUrl);
  const dissolveProgressRef = useRef(0);
  const scene = useMemo(() => {
    const cloned = gltf.scene.clone(true);

    cloned.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;

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
    const target = Math.min(spec.width, spec.height) * 0.82;

    return {
      scale: (target / maxDim) * 0.72,
      center: centerVec,
    };
  }, [scene, spec.height, spec.width]);
  const objectRef = useRef<Group>(null);
  const spinXRef = useRef(0);
  const spinYRef = useRef(0);
  const displayZ = open ? style.depth * 0.26 : style.depth * 0.04;
  const displayY = spec.y - spec.height * 0.04;

  useEffect(() => {
    dissolveProgressRef.current = dissolvePhase === "exiting" ? 1 : dissolvePhase === "entering" ? 0 : 1;
  }, [dissolvePhase, modelUrl]);

  useFrame((state, delta) => {
    if (!objectRef.current) return;

    const targetFloatY = active ? Math.sin(state.clock.elapsedTime * 1.3) * 0.016 : 0;
    const targetDissolve = dissolvePhase === "exiting" ? 0 : 1;
    dissolveProgressRef.current = MathUtils.damp(dissolveProgressRef.current, targetDissolve, 5.5, delta);
    const dissolve = dissolveProgressRef.current;

    if (active) {
      spinXRef.current += delta * 0.7;
      spinYRef.current += delta * 1.05;
    } else {
      spinXRef.current = MathUtils.damp(spinXRef.current, 0, 8, delta);
      spinYRef.current = MathUtils.damp(spinYRef.current, 0, 8, delta);
    }

    objectRef.current.position.y = MathUtils.damp(objectRef.current.position.y, targetFloatY, 4.5, delta);
    objectRef.current.position.z = MathUtils.damp(
      objectRef.current.position.z,
      -0.16 + (1 - dissolve) * -0.08,
      6,
      delta,
    );
    objectRef.current.rotation.x = spinXRef.current;
    objectRef.current.rotation.y = spinYRef.current;
    objectRef.current.scale.setScalar(0.88 + dissolve * 0.06);

    scene.traverse((child) => {
      if (!(child instanceof Mesh)) {
        return;
      }

      const materials = Array.isArray(child.material) ? child.material : [child.material];

      materials.forEach((material) => {
        if (!material || !("opacity" in material)) {
          return;
        }

        material.transparent = dissolve < 0.999;
        material.opacity = dissolve;
      });
    });
  });

  return (
    <group position={[spec.x, displayY, displayZ]} renderOrder={11}>
      <ambientLight intensity={1.0} />
      <pointLight position={[0, spec.height * 0.12, 0.22]} intensity={1.8} color="#ffd39a" distance={2.1} />
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

    const openAngle = hingeDirection * (Math.PI * 82 / 180);
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
          color="#f2d7aa"
          transparent
          opacity={0.16}
          roughness={0.08}
          metalness={0.04}
          transmission={0.82}
          ior={1.5}
          thickness={0.08}
          clearcoat={0.72}
          clearcoatRoughness={0.12}
          attenuationColor="#c98b43"
          attenuationDistance={1.6}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[-hingeDirection * spec.width * 0.5, 0.04, 0.076 + arcDepth]} renderOrder={17}>
        <planeGeometry args={[glassInsetWidth * 0.92, glassInsetHeight * 0.92]} />
        <meshBasicMaterial color="#f4c987" transparent opacity={0.08} depthWrite={false} />
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
  dissolvePhase,
  interactionLocked,
  onToggle,
}: {
  doorId: string;
  item?: CabinetItem;
  modelUrl?: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  woodTexture?: Texture | null;
  open: boolean;
  active: boolean;
  dissolvePhase: DissolvePhase;
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
      {item ? (
        modelUrl ? (
          <Suspense fallback={null}>
            <ModelDisplay modelUrl={modelUrl} spec={spec} style={style} open={open} active={active} dissolvePhase={dissolvePhase} />
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <ItemDisplay
              item={item}
              spec={spec}
              style={style}
              open={open}
              active={active}
              dissolvePhase={dissolvePhase}
            />
          </Suspense>
        )
      ) : null}
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

function CabinetPanel({
  group,
  placement,
  openedDoorIds,
  focusedDoorId,
  allItems,
  doorItemIds,
  doorDissolvePhases,
  interactionLocked,
  woodTextures,
  onToggleDoor,
}: {
  group: CabinetGroup;
  placement: FurniturePlacement;
  openedDoorIds: Record<string, boolean>;
  focusedDoorId: string;
  allItems: CabinetItem[];
  doorItemIds: Record<string, string>;
  doorDissolvePhases: Record<string, DissolvePhase>;
  interactionLocked: boolean;
  woodTextures: Texture[];
  onToggleDoor: (doorId: string) => void;
}) {
  const style = getCabinetStyle();
  const specs = getCompartmentSpecs(style, doorsPerCabinet);

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
          const item = allItems.find((candidate) => candidate.id === doorItemIds[doorId]);
          return (
            <CabinetCompartment
              key={doorId}
              doorId={doorId}
              item={item}
              modelUrl={item?.modelUrl}
              spec={spec}
              style={style}
              woodTexture={cabinetWoodTexture}
              open={Boolean(openedDoorIds[doorId])}
              active={focusedDoorId === doorId}
              dissolvePhase={doorDissolvePhases[doorId] ?? "idle"}
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
  doorDissolvePhases,
  interactionLocked,
  woodTextures,
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
  doorDissolvePhases: Record<string, DissolvePhase>;
  interactionLocked: boolean;
  woodTextures: Texture[];
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
      <ambientLight intensity={1.45} color="#ffdfb8" />
      <hemisphereLight args={["#ffd4a0", "#5c2f16", 1.25]} />
      <pointLight position={[0, 2.6, 0]} intensity={10} color="#ffbf78" />
      <pointLight position={[-2.8, 1.7, -1.5]} intensity={4.5} color="#ffd6a6" />
      <pointLight position={[2.8, 1.7, 1.5]} intensity={4.5} color="#ffb56c" />
      <spotLight
        position={[0, 2.8, 1.2]}
        angle={0.7}
        penumbra={0.75}
        intensity={12}
        color="#ffc98a"
        castShadow
      />

      <RoomArchitecture
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
              placement={placements[index]}
              openedDoorIds={openedDoorIds}
              focusedDoorId={focusedDoorId}
              allItems={allItems}
              doorItemIds={doorItemIds}
              doorDissolvePhases={doorDissolvePhases}
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

const cabinetWoodTextureFiles = ["/dark_wood.jpg"];

function CabinetPanoramaScene({ items }: CabinetPanoramaProps) {
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const groups = useMemo(() => chunkItems(items), [items]);
  const doorIds = useMemo(() => getDoorIdsForGroups(groups), [groups]);
  const placements = useMemo(() => getFurniturePlacements(groups), [groups]);
  const doorItemPools = useMemo(() => buildDoorItemPools(groups, items), [groups, items]);
  const initialDoorItemIds = useMemo(() => {
    const nextDoorItemIds: Record<string, string> = {};
    const assignedItemIds = new Set<string>();

    if (items.length === 0) {
      return nextDoorItemIds;
    }

    doorIds.forEach((doorId) => {
      nextDoorItemIds[doorId] = chooseInitialDoorItem(items, assignedItemIds);
    });

    return nextDoorItemIds;
  }, [doorIds, items]);
  const [doorItemIds, setDoorItemIds] = useState<Record<string, string>>(() => initialDoorItemIds);
  const [seenItemIds, setSeenItemIds] = useState<Record<string, boolean>>({});
  const [focusedDoorId, setFocusedDoorId] = useState("");
  const [openedDoorIds, setOpenedDoorIds] = useState<Record<string, boolean>>({});
  const [doorDissolvePhases, setDoorDissolvePhases] = useState<Record<string, DissolvePhase>>({});
  const [closingDoorId, setClosingDoorId] = useState("");
  const [returnPose, setReturnPose] = useState<CameraPose | null>(null);
  const [interactionLocked, setInteractionLocked] = useState(false);
  const focusedItem = useMemo(() => {
    if (!focusedDoorId) {
      return undefined;
    }

    const focusedItemId = doorItemIds[focusedDoorId];

    return items.find((item) => item.id === focusedItemId);
  }, [doorItemIds, focusedDoorId, items]);
  const [woodTextures, setWoodTextures] = useState<Texture[]>([]);
  const [rugTexture, setRugTexture] = useState<Texture | null>(null);
  const [floorTexture, setFloorTexture] = useState<Texture | null>(null);
  const mountedRef = useRef(false);
  const dissolveTimersRef = useRef<number[]>([]);
  const roamPoseRef = useRef<CameraPose>({
    cameraPosition: [0, 0.05, 0.25],
    yaw: 0,
  });

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

    return getDoorFocusTarget(groups[groupIndex], groupIndex, specIndex, placement);
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

    if (!focusedDoorId || !focusedItem) {
      return;
    }

    if (isDemoModelDoor(focusedDoorId, doorItemIds, itemsById)) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(buildBackstory(focusedItem));
    const applyVoice = () => {
      const preferredVoice = chooseNarrationVoice(speech.getVoices());

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
    };

    applyVoice();
    utterance.rate = 0.9;
    utterance.pitch = 0.88;
    utterance.volume = 1;
    utterance.onend = () => {
      setReturnPose(roamPoseRef.current);
      setFocusedDoorId("");
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
  }, [doorItemIds, focusedDoorId, focusedItem, itemsById]);

  useEffect(() => {
    return () => {
      dissolveTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      dissolveTimersRef.current = [];
    };
  }, []);

  const toggleDoor = (doorId: string) => {
    if (interactionLocked && focusedDoorId !== doorId) {
      return;
    }

    if (items.length === 0) {
      return;
    }

    const currentItemId = doorItemIds[doorId];
    if (!currentItemId) {
      return;
    }

    const resolvedItemId = currentItemId;
    const currentItem =
      items.find((candidate) => candidate.id === resolvedItemId) ??
      items[hashSeed(doorId) % Math.max(items.length, 1)];

    if (!currentItem) {
      return;
    }

    if (!openedDoorIds[doorId]) {
      setOpenedDoorIds({ [doorId]: true });
    }

    if (focusedDoorId === doorId) {
      setClosingDoorId(doorId);
      setOpenedDoorIds((currentDoors) => {
        if (!currentDoors[doorId]) {
          return currentDoors;
        }

        return { ...currentDoors, [doorId]: false };
      });
      setReturnPose(roamPoseRef.current);
      setFocusedDoorId("");
      return;
    }

    setSeenItemIds((currentSeenItemIds) => ({
      ...currentSeenItemIds,
      [currentItem.id]: true,
    }));

    if (openedDoorIds[doorId] && !focusedDoorId) {
      setOpenedDoorIds({ [doorId]: true });
      setInteractionLocked(true);
      setFocusedDoorId(doorId);
      setReturnPose(null);
      return;
    }

    setOpenedDoorIds({ [doorId]: true });
    setInteractionLocked(true);
    setFocusedDoorId(doorId);
    setReturnPose(null);
  };

  const handleRoamPoseChange = useCallback((pose: CameraPose) => {
    roamPoseRef.current = pose;
  }, []);

  const handleTargetReached = useCallback((mode: "focus" | "return") => {
    if (mode === "return") {
      if (closingDoorId) {
        const currentItemId = doorItemIds[closingDoorId];
        const pool = doorItemPools[closingDoorId] ?? [];

        if (currentItemId && pool.length > 0) {
          const nextItemId = chooseNextPoolItem(pool, currentItemId, {
            ...seenItemIds,
            [currentItemId]: true,
          }, itemsById, Object.entries(doorItemIds)
            .filter(([candidateDoorId, itemId]) => candidateDoorId !== closingDoorId && Boolean(itemId))
            .map(([, itemId]) => itemId));

          if (nextItemId && nextItemId !== currentItemId) {
            setDoorDissolvePhases((currentPhases) => ({
              ...currentPhases,
              [closingDoorId]: "exiting",
            }));

            const doorId = closingDoorId;
            const swapTimer = window.setTimeout(() => {
              setDoorItemIds((currentDoorItemIds) => ({
                ...currentDoorItemIds,
                [doorId]: nextItemId,
              }));
              setDoorDissolvePhases((currentPhases) => ({
                ...currentPhases,
                [doorId]: "entering",
              }));
            }, 220);

            const settleTimer = window.setTimeout(() => {
              setDoorDissolvePhases((currentPhases) => ({
                ...currentPhases,
                [doorId]: "idle",
              }));
            }, 560);

            dissolveTimersRef.current.push(swapTimer, settleTimer);
          }
        }

        setClosingDoorId("");
      }

      setReturnPose(null);
      setInteractionLocked(false);
    }
  }, [closingDoorId, doorItemIds, doorItemPools, itemsById, seenItemIds]);

  return (
    <section className="panorama-shell" aria-label="Cabinet of curiosities panorama">
      <div className="panorama-stage">
        <Canvas
          camera={{ position: [0, 0.05, 0.25], fov: 72, near: 0.1, far: 40 }}
          shadows
          gl={{ antialias: true, alpha: false }}
        >
          {woodTextures.length > 0 && rugTexture && floorTexture && (
            <Suspense fallback={null}>
              <CabinetRoom
                allItems={items}
                groups={groups}
                placements={placements}
                openedDoorIds={openedDoorIds}
                focusedDoorId={focusedDoorId}
                doorItemIds={doorItemIds}
                doorDissolvePhases={doorDissolvePhases}
                interactionLocked={interactionLocked}
                woodTextures={woodTextures}
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

export function CabinetPanorama({ items }: CabinetPanoramaProps) {
  const sceneKey = useMemo(() => items.map((item) => item.id).join("|"), [items]);

  return <CabinetPanoramaScene key={sceneKey} items={items} />;
}
