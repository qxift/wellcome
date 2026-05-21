"use client";

import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box3,
  CanvasTexture,
  Color,
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
import cabinetStories from "@/data/cabinetStories.llm.json";

type BlendableDoorMaterial = MeshStandardMaterial & {
  userData: MeshStandardMaterial["userData"] & {
    textureBlendShader?: {
      uniforms: {
        uBlendFactor?: { value: number };
        uBlendMap?: { value: Texture };
      };
    };
  };
};

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

type PendingDoorSwap = {
  doorId: string;
  nextItemId: string;
} | null;

type SuggestionMode = "shake" | "creak" | "color" | "size";

type DoorSuggestionCue = {
  doorId: string;
  nonce: number;
  mode: SuggestionMode;
} | null;

const postZoomSwapDelayMs = 220;
const idleShakeDelayMs = 5000;
const suggestionModeCycle: SuggestionMode[] = ["shake", "creak", "color", "size"];

const playerRadius = 0.28;
const roomRadius = 4.385;
const itemsPerCabinet = 8;
const doorsPerCabinet = 8;
const cabinetsPerRow = 9;
const backgroundSeedTolerance = 42;
const backgroundFloodTolerance = 54;
const backgroundNeighborTolerance = 34;
const alphaVisibilityThreshold = 24;

function createWoodShakeNoiseBuffer(context: AudioContext) {
  const durationSeconds = 0.18;
  const frameCount = Math.max(1, Math.floor(context.sampleRate * durationSeconds));
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < frameCount; index += 1) {
    const progress = index / frameCount;
    const taper = 1 - progress * 0.45;
    channel[index] = (Math.random() * 2 - 1) * taper;
  }

  return buffer;
}

function playWoodShakeBurst(context: AudioContext, noiseBuffer: AudioBuffer) {
  const startAt = context.currentTime;
  const noiseSource = context.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.playbackRate.value = 0.78 + Math.random() * 0.18;

  const noiseBandpass = context.createBiquadFilter();
  noiseBandpass.type = "bandpass";
  noiseBandpass.frequency.value = 420 + Math.random() * 180;
  noiseBandpass.Q.value = 0.7;

  const noiseLowpass = context.createBiquadFilter();
  noiseLowpass.type = "lowpass";
  noiseLowpass.frequency.value = 980 + Math.random() * 260;

  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(0.0001, startAt);
  noiseGain.gain.linearRampToValueAtTime(0.15 + Math.random() * 0.05, startAt + 0.012);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);

  noiseSource.connect(noiseBandpass);
  noiseBandpass.connect(noiseLowpass);
  noiseLowpass.connect(noiseGain);
  noiseGain.connect(context.destination);
  noiseSource.start(startAt);
  noiseSource.stop(startAt + 0.15);

  const thunk = context.createOscillator();
  thunk.type = "triangle";
  thunk.frequency.setValueAtTime(112 + Math.random() * 28, startAt);
  thunk.frequency.exponentialRampToValueAtTime(76 + Math.random() * 16, startAt + 0.08);

  const thunkLowpass = context.createBiquadFilter();
  thunkLowpass.type = "lowpass";
  thunkLowpass.frequency.value = 340;

  const thunkGain = context.createGain();
  thunkGain.gain.setValueAtTime(0.0001, startAt);
  thunkGain.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.03, startAt + 0.01);
  thunkGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.11);

  thunk.connect(thunkLowpass);
  thunkLowpass.connect(thunkGain);
  thunkGain.connect(context.destination);
  thunk.start(startAt);
  thunk.stop(startAt + 0.12);

  if (Math.random() > 0.35) {
    const aftershockSource = context.createBufferSource();
    aftershockSource.buffer = noiseBuffer;
    aftershockSource.playbackRate.value = 0.92 + Math.random() * 0.24;

    const aftershockLowpass = context.createBiquadFilter();
    aftershockLowpass.type = "lowpass";
    aftershockLowpass.frequency.value = 760 + Math.random() * 220;

    const aftershockGain = context.createGain();
    const aftershockStartAt = startAt + 0.04 + Math.random() * 0.04;
    aftershockGain.gain.setValueAtTime(0.0001, aftershockStartAt);
    aftershockGain.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.03, aftershockStartAt + 0.008);
    aftershockGain.gain.exponentialRampToValueAtTime(0.0001, aftershockStartAt + 0.08);

    aftershockSource.connect(aftershockLowpass);
    aftershockLowpass.connect(aftershockGain);
    aftershockGain.connect(context.destination);
    aftershockSource.start(aftershockStartAt);
    aftershockSource.stop(aftershockStartAt + 0.09);
  }
}

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
    wood: "#6a4128",
    woodTextureIndex: 0,
  };
}

function getCompartmentSpecs(style: CabinetStyle, count: number): CompartmentSpec[] {
  const innerWidth = style.width - 0.004;
  const innerHeight = style.height - 0.004;
  const columns = 2;
  const rows = 4;
  const gap = 0;
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
  const nextModelItemId = items.find((item) => item.modelUrl && !assignedItemIds.has(item.id))?.id ?? "";
  const nextFallbackItemId = items.find((item) => !assignedItemIds.has(item.id))?.id ?? "";
  const nextItemId = nextModelItemId || nextFallbackItemId;

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

function chooseConnectedClosedDoor(
  sourceDoorId: string,
  doorItemIds: Record<string, string>,
  openedDoorIds: Record<string, boolean>,
  itemsById: Map<string, CabinetItem>,
) {
  const sourceItemId = doorItemIds[sourceDoorId];

  if (!sourceItemId) {
    return "";
  }

  const sourceKeywords = new Set(itemsById.get(sourceItemId)?.linkKeywords ?? []);

  if (sourceKeywords.size === 0) {
    return "";
  }

  const candidates = Object.entries(doorItemIds)
    .map(([doorId, itemId]) => ({ doorId, itemId, item: itemId ? itemsById.get(itemId) : undefined }))
    .filter(({ doorId, item }) => {
      if (doorId === sourceDoorId || openedDoorIds[doorId]) {
        return false;
      }

      return (item?.linkKeywords ?? []).some((keyword) => sourceKeywords.has(keyword));
    })
    .sort((left, right) => {
      const leftShared = (left.item?.linkKeywords ?? []).filter((keyword) => sourceKeywords.has(keyword)).length;
      const rightShared = (right.item?.linkKeywords ?? []).filter((keyword) => sourceKeywords.has(keyword)).length;
      return rightShared - leftShared;
    });

  if (candidates.length === 0) {
    return "";
  }

  const topCandidates = candidates.slice(0, Math.min(4, candidates.length));
  const choice = topCandidates[Math.floor(Math.random() * topCandidates.length)];

  return choice?.doorId ?? "";
}

function chooseRandomClosedDoor(
  doorItemIds: Record<string, string>,
  openedDoorIds: Record<string, boolean>,
) {
  const candidates = Object.keys(doorItemIds).filter((doorId) => !openedDoorIds[doorId]);

  if (candidates.length === 0) {
    return "";
  }

  return candidates[Math.floor(Math.random() * candidates.length)] ?? "";
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
  const story = cabinetStories[item.id as keyof typeof cabinetStories];
  if (story) {
    return story;
  }

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
    "aria",
    "jenny",
    "ava",
    "samantha",
    "zira",
    "allison",
    "moira",
    "serena",
    "karen",
    "daniel",
    "libby",
    "google uk english female",
    "google us english",
    "microsoft aria",
    "microsoft jenny",
    "microsoft zira",
    "natural",
    "neural",
    "online",
    "bright",
  ];

  return [...voices]
    .filter((voice) => voice.lang.toLowerCase().startsWith("en"))
    .sort((left, right) => {
      const scoreVoice = (voice: SpeechSynthesisVoice) => {
        const name = voice.name.toLowerCase();
        let score = 0;

        if (voice.default) score += 8;
        if (voice.localService) score += 10;
        if (voice.lang.toLowerCase().startsWith("en-gb")) score += 8;
        if (voice.lang.toLowerCase().startsWith("en-us")) score += 6;
        if (preferredNames.some((preferred) => name.includes(preferred))) score += 30;
        if (name.includes("female")) score += 6;
        if (name.includes("natural")) score += 8;
        if (name.includes("neural")) score += 10;
        if (name.includes("online")) score += 6;
        if (name.includes("bright")) score += 8;
        if (name.includes("enhanced")) score += 5;
        if (name.includes("compact")) score -= 8;
        if (name.includes("novelty")) score -= 20;
        if (name.includes("old")) score -= 4;

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
  const { texture: displayTexture, contentWidth, contentHeight } = useMemo(() => buildDisplayTexture(texture), [texture]);
  const { imageWidth, imageHeight } = useMemo(() => {
    const maxWidth = spec.width * 0.76;
    const maxHeight = spec.height * 0.66;
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

  useFrame((state, delta) => {
    if (!objectRef.current) return;

    const targetFloatY = active ? Math.sin(state.clock.elapsedTime * 1.3) * 0.012 : 0;
    const targetRotationY = active ? Math.sin(state.clock.elapsedTime * 0.7) * 0.08 : 0;
    const targetDepth = active ? 0.32 : 0;

    objectRef.current.position.y = MathUtils.damp(objectRef.current.position.y, targetFloatY, 4, delta);
    objectRef.current.rotation.y = MathUtils.damp(objectRef.current.rotation.y, targetRotationY, 4, delta);
    objectRef.current.rotation.x = MathUtils.damp(objectRef.current.rotation.x, active ? -0.04 : 0, 4, delta);
    objectRef.current.position.z = MathUtils.damp(objectRef.current.position.z, targetDepth, 6, delta);
    objectRef.current.scale.setScalar(active ? 1.34 : open ? 1.08 : 1);
  });

  const displayZ = open ? style.depth * 0.3 : style.depth * 0.1;
  const displayY = spec.y - spec.height * 0.04;

  return (
    <group position={[spec.x, displayY, displayZ]} renderOrder={11}>
      <group ref={objectRef}>
        <mesh position={[0, 0, 0.002]} renderOrder={12}>
          <planeGeometry args={[imageWidth, imageHeight]} />
          <meshBasicMaterial
            map={displayTexture}
            color="#dbc7a3"
            transparent
            alphaTest={0.04}
            depthWrite={false}
            side={DoubleSide}
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
    const target = Math.min(spec.width, spec.height) * 0.94;

    return {
      scale: (target / maxDim) * 0.84,
      center: centerVec,
    };
  }, [scene, spec.height, spec.width]);
  const objectRef = useRef<Group>(null);
  const spinXRef = useRef(0);
  const spinYRef = useRef(0);
  const displayZ = open ? style.depth * 0.26 : style.depth * 0.04;
  const displayY = spec.y - spec.height * 0.04;

  useFrame((state, delta) => {
    if (!objectRef.current) return;

    const targetFloatY = active ? Math.sin(state.clock.elapsedTime * 1.3) * 0.016 : 0;
    const targetDepth = active ? 0.18 : -0.16;

    if (active) {
      spinXRef.current += delta * 0.7;
      spinYRef.current += delta * 1.05;
    } else {
      spinXRef.current = MathUtils.damp(spinXRef.current, 0, 8, delta);
      spinYRef.current = MathUtils.damp(spinYRef.current, 0, 8, delta);
    }

    objectRef.current.position.y = MathUtils.damp(objectRef.current.position.y, targetFloatY, 4.5, delta);
    objectRef.current.position.z = MathUtils.damp(objectRef.current.position.z, targetDepth, 6, delta);
    objectRef.current.rotation.x = spinXRef.current;
    objectRef.current.rotation.y = spinYRef.current;
    objectRef.current.scale.setScalar(active ? 1.28 : 1.02);
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
  active,
  hasFocusedDoor,
  suggestionMode,
  suggestionNonce,
  interactionLocked,
  onToggle,
  woodTexture,
}: {
  doorId: string;
  spec: CompartmentSpec;
  style: CabinetStyle;
  open: boolean;
  active: boolean;
  hasFocusedDoor: boolean;
  suggestionMode: SuggestionMode | null;
  suggestionNonce: number;
  interactionLocked: boolean;
  woodTexture?: Texture | null;
  onToggle: (doorId: string) => void;
}) {
  const frontRef = useRef<Group>(null);
  const visualRef = useRef<Group>(null);
  const backingRef = useRef<Mesh>(null);
  const panelRef = useRef<Mesh>(null);
  const suggestionElapsedRef = useRef(0);
  const lastSuggestionNonceRef = useRef(suggestionNonce);
  const frameMaterialRefs = useRef<MeshStandardMaterial[]>([]);
  const metalMaterialRefs = useRef<MeshStandardMaterial[]>([]);
  const panelMaterialRef = useRef<MeshStandardMaterial | null>(null);
  const backingMaterialRef = useRef<MeshStandardMaterial | null>(null);
  const frontZ = style.depth * 0.15; // Adjusted for new depth
  const hingeDirection = spec.type === "door-left" ? -1 : 1;
  const baseFrontX = spec.x + hingeDirection * spec.width * 0.5;
  const arcDepth = spec.width * 0.04;
  const doorOverlap = 0.028;
  const redWoodSource = useLoader(TextureLoader, "/red_wood.png");
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
  const backingTexture = useMemo(() => {
    if (!woodTexture) {
      return null;
    }

    const texture = woodTexture.clone();
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(0.95, 0.95);
    texture.needsUpdate = true;
    return texture;
  }, [woodTexture]);
  const redWoodTexture = useMemo(() => {
    const texture = redWoodSource.clone();
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.colorSpace = SRGBColorSpace;
    texture.repeat.set(2.2, 2.2);
    texture.needsUpdate = true;
    return texture;
  }, [redWoodSource]);
  const panelRedWoodTexture = useMemo(() => {
    const texture = redWoodSource.clone();
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.colorSpace = SRGBColorSpace;
    texture.repeat.set(1.9, 1.9);
    texture.needsUpdate = true;
    return texture;
  }, [redWoodSource]);
  const doorWoodMaterialProps = {
    map: doorFrameTexture ?? woodTexture ?? undefined,
    color: style.wood,
    roughness: 0.78,
    metalness: 0.04,
  };
  const panelInsetWidth = Math.max(0.12, spec.width - 0.16);
  const panelInsetHeight = Math.max(0.16, spec.height - 0.16);
  const baseWoodColor = useMemo(() => new Color(style.wood), [style.wood]);
  const panelWoodColor = useMemo(() => new Color("#5a321d"), []);
  const redWoodBackingTint = useMemo(() => new Color("#9a735f"), []);
  const redWoodPanelTint = useMemo(() => new Color("#7f5b49"), []);
  const brassColor = useMemo(() => new Color("#d3a95f"), []);
  const blackColor = useMemo(() => new Color("#000000"), []);
  const darkPurpleWoodColor = useMemo(() => new Color("#3e1f52"), []);
  const darkPurpleMetalColor = useMemo(() => new Color("#2b1339"), []);

  useEffect(() => {
    const applyTextureBlend = (material: MeshStandardMaterial | null, blendTexture: Texture) => {
      if (!material) {
        return;
      }

      const blendableMaterial = material as BlendableDoorMaterial;
      blendableMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uBlendMap = { value: blendTexture };
        shader.uniforms.uBlendFactor = { value: 0 };

        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <map_pars_fragment>",
          "#include <map_pars_fragment>\nuniform sampler2D uBlendMap;\nuniform float uBlendFactor;",
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <map_fragment>",
          `#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	vec4 sampledBlendColor = texture2D( uBlendMap, vMapUv );
	sampledDiffuseColor = mix( sampledDiffuseColor, sampledBlendColor, uBlendFactor );
	diffuseColor *= sampledDiffuseColor;
#endif`,
        );

        blendableMaterial.userData.textureBlendShader = shader;
      };

      blendableMaterial.customProgramCacheKey = () => `texture-blend-${blendTexture.uuid}`;
      blendableMaterial.needsUpdate = true;
    };

    applyTextureBlend(backingMaterialRef.current, redWoodTexture);
    applyTextureBlend(panelMaterialRef.current, panelRedWoodTexture);
  }, [panelRedWoodTexture, redWoodTexture]);

  const setFrameMaterialRef = useCallback((material: MeshStandardMaterial | null) => {
    if (!material) {
      return;
    }

    if (!frameMaterialRefs.current.includes(material)) {
      frameMaterialRefs.current.push(material);
    }
  }, []);

  const setMetalMaterialRef = useCallback((material: MeshStandardMaterial | null) => {
    if (!material) {
      return;
    }

    if (!metalMaterialRefs.current.includes(material)) {
      metalMaterialRefs.current.push(material);
    }
  }, []);

  useFrame((_, delta) => {
    if (!frontRef.current) return;

    const openAngle = hingeDirection * (Math.PI * 82 / 180);
    const ajarAngle = openAngle * 0.18;
    const targetRotation = active ? openAngle : open ? (hasFocusedDoor ? ajarAngle : openAngle) : 0;

    if (lastSuggestionNonceRef.current !== suggestionNonce) {
      lastSuggestionNonceRef.current = suggestionNonce;
      suggestionElapsedRef.current = 0;
    }

    suggestionElapsedRef.current += delta;
    const elapsed = suggestionElapsedRef.current;
    const isSuggesting = Boolean(suggestionMode);
    const pulse = isSuggesting ? 0.5 + 0.5 * Math.sin(elapsed * 4.8) : 0;
    const colorPulse = isSuggesting ? 0.5 + 0.5 * Math.sin(elapsed * 1.8) : 0;
    const swingPulse = isSuggesting ? 0.5 + 0.5 * Math.sin(elapsed * 9.6) : 0;

    let rotationOffsetY = 0;
    let offsetX = 0;
    let offsetZ = 0;
    let tiltX = 0;
    let tiltZ = 0;
    let scaleX = 1;
    let scaleY = 1;
    let scaleZ = 1;
    let backingScaleX = 1;
    let backingScaleY = 1;
    let backingScaleZ = 1;
    let panelScaleX = 1;
    let panelScaleY = 1;
    let panelScaleZ = 1;
    let colorMix = 0;

    switch (suggestionMode) {
      case "shake":
        rotationOffsetY =
          Math.sin(elapsed * 38) * 0.14 +
          Math.sin(elapsed * 83) * 0.06;
        offsetZ = Math.sin(elapsed * 71) * 0.028;
        offsetX = Math.sin(elapsed * 54) * hingeDirection * 0.012;
        tiltX = Math.sin(elapsed * 92) * 0.035;
        tiltZ = Math.sin(elapsed * 64) * 0.025;
        break;
      case "size":
        {
          const sizeMorph = 0.5 + 0.5 * Math.sin(elapsed * 3.6);
          scaleX = MathUtils.lerp(0.72, 1.52, sizeMorph);
          scaleY = MathUtils.lerp(1.52, 0.72, sizeMorph);
          scaleZ = 1.12 + pulse * 0.22;
          backingScaleX = 1.02;
          backingScaleY = 1.02;
          backingScaleZ = 1.03;
          panelScaleX = MathUtils.lerp(0.94, 1.08, sizeMorph);
          panelScaleY = MathUtils.lerp(1.08, 0.94, sizeMorph);
          panelScaleZ = 1.04 + pulse * 0.04;
          offsetZ = pulse * 0.06;
          offsetX = Math.sin(elapsed * 4.4) * hingeDirection * 0.018;
          tiltX = Math.sin(elapsed * 6.6) * 0.024;
          tiltZ = Math.sin(elapsed * 8.2) * 0.04;
        }
        break;
      case "color":
        colorMix = colorPulse * 0.5;
        break;
      case "creak": {
        const cycleDuration = 3.8;
        const cycleTime = elapsed % cycleDuration;
        const openDuration = 2;
        const holdDuration = 0.2;
        const closeDuration = 0.18;
        const settleDuration = 0.4;
        const maxOpenOffset = 0.38;
        let creakProgress = 0;

        if (cycleTime < openDuration) {
          const openProgress = cycleTime / openDuration;
          creakProgress = MathUtils.smootherstep(openProgress, 0, 1);
        } else if (cycleTime < openDuration + holdDuration) {
          creakProgress = 1;
        } else if (cycleTime < openDuration + holdDuration + closeDuration) {
          const closeProgress = (cycleTime - openDuration - holdDuration) / closeDuration;
          creakProgress = 1 - MathUtils.smootherstep(closeProgress, 0, 1);
        } else if (cycleTime < openDuration + holdDuration + closeDuration + settleDuration) {
          const settleProgress = (cycleTime - openDuration - holdDuration - closeDuration) / settleDuration;
          creakProgress = (1 - MathUtils.smootherstep(settleProgress, 0, 1)) * 0.06;
        }

        rotationOffsetY = hingeDirection * maxOpenOffset * creakProgress;
        offsetZ = creakProgress * 0.032;
        tiltX = -creakProgress * 0.032;
        break;
      }
      default:
        break;
    }

    frontRef.current.rotation.y = MathUtils.damp(
      frontRef.current.rotation.y,
      targetRotation + rotationOffsetY,
      14,
      delta,
    );
    frontRef.current.rotation.x = MathUtils.damp(frontRef.current.rotation.x, tiltX, 12, delta);
    frontRef.current.rotation.z = MathUtils.damp(frontRef.current.rotation.z, tiltZ, 12, delta);
    frontRef.current.position.x = MathUtils.damp(frontRef.current.position.x, baseFrontX + offsetX, 14, delta);
    frontRef.current.position.z = MathUtils.damp(frontRef.current.position.z, frontZ + offsetZ, 14, delta);
    if (visualRef.current) {
      visualRef.current.scale.x = MathUtils.damp(visualRef.current.scale.x, scaleX, 10, delta);
      visualRef.current.scale.y = MathUtils.damp(visualRef.current.scale.y, scaleY, 10, delta);
      visualRef.current.scale.z = MathUtils.damp(visualRef.current.scale.z, scaleZ, 10, delta);
    }

    if (backingRef.current) {
      backingRef.current.scale.x = MathUtils.damp(backingRef.current.scale.x, backingScaleX, 10, delta);
      backingRef.current.scale.y = MathUtils.damp(backingRef.current.scale.y, backingScaleY, 10, delta);
      backingRef.current.scale.z = MathUtils.damp(backingRef.current.scale.z, backingScaleZ, 10, delta);
    }

    if (backingMaterialRef.current?.map) {
      backingMaterialRef.current.map.repeat.set(
        0.95 / Math.max(backingScaleX, 0.001),
        0.95 / Math.max(backingScaleY, 0.001),
      );
      backingMaterialRef.current.map.needsUpdate = true;
      const shader = (backingMaterialRef.current as BlendableDoorMaterial).userData.textureBlendShader;
      if (shader?.uniforms.uBlendFactor) {
        shader.uniforms.uBlendFactor.value = suggestionMode === "color" ? colorMix : 0;
      }
      if (shader?.uniforms.uBlendMap) {
        shader.uniforms.uBlendMap.value.repeat.set(
          2.2 / Math.max(backingScaleX, 0.001),
          2.2 / Math.max(backingScaleY, 0.001),
        );
        shader.uniforms.uBlendMap.value.needsUpdate = true;
      }
    }

    if (panelRef.current) {
      panelRef.current.scale.x = MathUtils.damp(panelRef.current.scale.x, panelScaleX, 10, delta);
      panelRef.current.scale.y = MathUtils.damp(panelRef.current.scale.y, panelScaleY, 10, delta);
      panelRef.current.scale.z = MathUtils.damp(panelRef.current.scale.z, panelScaleZ, 10, delta);
    }

    if (panelMaterialRef.current) {
      const shader = (panelMaterialRef.current as BlendableDoorMaterial).userData.textureBlendShader;
      if (shader?.uniforms.uBlendFactor) {
        shader.uniforms.uBlendFactor.value = suggestionMode === "color" ? colorMix : 0;
      }
    }

    for (const material of frameMaterialRefs.current) {
      material.color.lerpColors(
        baseWoodColor,
        darkPurpleWoodColor,
        suggestionMode === "color" ? colorMix * 0.85 : 0,
      );
      material.emissive.copy(blackColor);
      material.emissiveIntensity = 0;
    }

    if (backingMaterialRef.current) {
      backingMaterialRef.current.color.lerpColors(
        baseWoodColor,
        redWoodBackingTint,
        suggestionMode === "color" ? colorMix * 0.85 : 0,
      );
      backingMaterialRef.current.emissive.copy(blackColor);
      backingMaterialRef.current.emissiveIntensity = 0;
    }

    if (panelMaterialRef.current) {
      panelMaterialRef.current.color.lerpColors(
        panelWoodColor,
        redWoodPanelTint,
        suggestionMode === "color" ? colorMix * 0.85 : 0,
      );
      panelMaterialRef.current.emissive.copy(blackColor);
      panelMaterialRef.current.emissiveIntensity = 0;
    }

    for (const material of metalMaterialRefs.current) {
      material.color.lerpColors(
        brassColor,
        darkPurpleMetalColor,
        suggestionMode === "color" ? Math.min(1, colorMix * 1.6) : 0,
      );
      material.emissive.copy(blackColor);
      material.emissiveIntensity = 0;
    }
  });

  const handleClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (interactionLocked && !open) return;
    onToggle(doorId);
  };

  return (
    <group
      ref={frontRef}
      position={[baseFrontX, spec.y, frontZ]}
      onClick={handleClick}
    >
      <mesh
        ref={backingRef}
        position={[-hingeDirection * spec.width * 0.5, 0, 0.01 + arcDepth]}
        castShadow
      >
        <boxGeometry args={[panelInsetWidth + 0.08, panelInsetHeight + 0.08, 0.06]} />
        <meshStandardMaterial
          ref={backingMaterialRef}
          map={backingTexture ?? doorFrameTexture ?? woodTexture ?? undefined}
          color={style.wood}
          roughness={0.8}
          metalness={0.03}
        />
      </mesh>
      <group ref={visualRef} position={[-hingeDirection * spec.width * 0.5, 0, 0]}>
        <mesh position={[hingeDirection * (spec.width * 0.5 - 0.06), 0, 0.02 + arcDepth]} castShadow>
          <boxGeometry args={[0.12, spec.height + doorOverlap * 2, 0.08]} />
          <meshStandardMaterial ref={setFrameMaterialRef} {...doorWoodMaterialProps} roughness={0.82} />
        </mesh>
        <mesh position={[-hingeDirection * (spec.width * 0.5 - 0.06), 0, 0.02 + arcDepth]} castShadow>
          <boxGeometry args={[0.12, spec.height + doorOverlap * 2, 0.08]} />
          <meshStandardMaterial ref={setFrameMaterialRef} {...doorWoodMaterialProps} roughness={0.82} />
        </mesh>
        <mesh position={[0, spec.height * 0.5 - 0.05, 0.02 + arcDepth]} castShadow>
          <boxGeometry args={[spec.width + doorOverlap * 2, 0.12, 0.08]} />
          <meshStandardMaterial ref={setFrameMaterialRef} {...doorWoodMaterialProps} roughness={0.82} />
        </mesh>
        <mesh position={[0, -spec.height * 0.5 + 0.05, 0.02 + arcDepth]} castShadow>
          <boxGeometry args={[spec.width + doorOverlap * 2, 0.12, 0.08]} />
          <meshStandardMaterial ref={setFrameMaterialRef} {...doorWoodMaterialProps} roughness={0.82} />
        </mesh>
        <mesh ref={panelRef} position={[0, 0, 0.068 + arcDepth]} renderOrder={16}>
          <boxGeometry args={[panelInsetWidth, panelInsetHeight, 0.03]} />
          <meshStandardMaterial
            ref={panelMaterialRef}
            {...doorWoodMaterialProps}
            color="#5a321d"
            roughness={0.86}
            metalness={0.02}
          />
        </mesh>
        <mesh position={[0, spec.height * 0.26, 0.095 + arcDepth]}>
          <boxGeometry args={[spec.width - 0.12, 0.032, 0.028]} />
          <meshStandardMaterial ref={setMetalMaterialRef} color="#d3a95f" roughness={0.34} metalness={0.62} />
        </mesh>
        <mesh position={[0, -spec.height * 0.26, 0.095 + arcDepth]}>
          <boxGeometry args={[spec.width - 0.12, 0.032, 0.028]} />
          <meshStandardMaterial ref={setMetalMaterialRef} color="#d3a95f" roughness={0.34} metalness={0.62} />
        </mesh>
        <mesh position={[-hingeDirection * (spec.width * 0.5 - 0.14), -spec.height * 0.12, 0.11 + arcDepth]}>
          <sphereGeometry args={[0.045, 18, 18]} />
          <meshStandardMaterial ref={setMetalMaterialRef} color="#d3a95f" roughness={0.28} metalness={0.72} />
        </mesh>
      </group>
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
  hasFocusedDoor,
  suggestionMode,
  suggestionNonce,
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
  hasFocusedDoor: boolean;
  suggestionMode: SuggestionMode | null;
  suggestionNonce: number;
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
            <ModelDisplay modelUrl={modelUrl} spec={spec} style={style} open={open} active={active} />
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <ItemDisplay
              item={item}
              spec={spec}
              style={style}
              open={open}
              active={active}
            />
          </Suspense>
        )
      ) : null}
      <ClickableFront
        doorId={doorId}
        spec={spec}
        style={style}
        open={open}
        active={active}
        hasFocusedDoor={hasFocusedDoor}
        suggestionMode={suggestionMode}
        suggestionNonce={suggestionNonce}
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
  suggestionCue,
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
  suggestionCue: DoorSuggestionCue;
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
              hasFocusedDoor={Boolean(focusedDoorId)}
              suggestionMode={suggestionCue?.doorId === doorId ? suggestionCue.mode : null}
              suggestionNonce={suggestionCue?.doorId === doorId ? suggestionCue.nonce : 0}
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

      // Keep the roam pose aligned with the real camera during the return trip
      // so free movement resumes without a second handoff jump.
      if (targetMode === "return") {
        onRoamPoseChange({
          cameraPosition: [sceneCamera.position.x, sceneCamera.position.y, sceneCamera.position.z],
          yaw: yaw.current,
        });
      }

      if (targetMode && settledTargetModeRef.current !== targetMode) {
        const distance =
          Math.abs(sceneCamera.position.x - focusTarget.cameraPosition[0]) +
          Math.abs(sceneCamera.position.y - focusTarget.cameraPosition[1]) +
          Math.abs(sceneCamera.position.z - focusTarget.cameraPosition[2]);
        const yawDistance = Math.abs(yaw.current - focusTarget.yaw);

        if (distance < 0.03 && yawDistance < 0.03) {
          sceneCamera.position.set(
            focusTarget.cameraPosition[0],
            focusTarget.cameraPosition[1],
            focusTarget.cameraPosition[2],
          );
          yaw.current = focusTarget.yaw;
          lookAtRef.current.set(
            focusTarget.lookAt[0],
            focusTarget.lookAt[1],
            focusTarget.lookAt[2],
          );
          sceneCamera.lookAt(lookAtRef.current);

          if (targetMode === "return") {
            onRoamPoseChange({
              cameraPosition: [
                focusTarget.cameraPosition[0],
                focusTarget.cameraPosition[1],
                focusTarget.cameraPosition[2],
              ],
              yaw: focusTarget.yaw,
            });
          }

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
  suggestionCue,
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
  suggestionCue: DoorSuggestionCue;
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
              suggestionCue={suggestionCue}
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
  const [closingDoorId, setClosingDoorId] = useState("");
  const [pendingDoorSwap, setPendingDoorSwap] = useState<PendingDoorSwap>(null);
  const [suggestionCue, setSuggestionCue] = useState<DoorSuggestionCue>(null);
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
  const returnReleaseFrameRef = useRef<number | null>(null);
  const roamPoseRef = useRef<CameraPose>({
    cameraPosition: [0, 0.05, 0.25],
    yaw: 0,
  });
  const lastInteractionAtRef = useRef(0);
  const shakeAudioContextRef = useRef<AudioContext | null>(null);
  const shakeNoiseBufferRef = useRef<AudioBuffer | null>(null);
  const shakeAudioStopRef = useRef<(() => void) | null>(null);
  const suggestionCueRef = useRef<DoorSuggestionCue>(null);
  const suggestionNonceRef = useRef(0);
  const suggestionModeIndexRef = useRef(0);

  useEffect(() => {
    lastInteractionAtRef.current = Date.now();
  }, []);

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

    const utterance = new SpeechSynthesisUtterance(buildBackstory(focusedItem));
    const applyVoice = () => {
      const preferredVoice = chooseNarrationVoice(speech.getVoices());

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
    };

    applyVoice();
    utterance.rate = 1.10;
    utterance.pitch = 1.12;
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
      if (returnReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(returnReleaseFrameRef.current);
      }
      if (shakeAudioStopRef.current) {
        shakeAudioStopRef.current();
        shakeAudioStopRef.current = null;
      }
      if (shakeAudioContextRef.current) {
        void shakeAudioContextRef.current.close().catch(() => {});
        shakeAudioContextRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    suggestionCueRef.current = suggestionCue;
  }, [suggestionCue]);

  useEffect(() => {
    if (!pendingDoorSwap || returnPose || interactionLocked) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDoorItemIds((currentDoorItemIds) => ({
        ...currentDoorItemIds,
        [pendingDoorSwap.doorId]: pendingDoorSwap.nextItemId,
      }));
      setPendingDoorSwap(null);
    }, postZoomSwapDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [interactionLocked, pendingDoorSwap, returnPose]);

  const stopShakeAudio = useCallback(() => {
    if (shakeAudioStopRef.current) {
      shakeAudioStopRef.current();
      shakeAudioStopRef.current = null;
    }
  }, []);

  const startShakeAudio = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const AudioContextCtor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextCtor) {
      return;
    }

    const context = shakeAudioContextRef.current ?? new AudioContextCtor();
    shakeAudioContextRef.current = context;

    const noiseBuffer = shakeNoiseBufferRef.current ?? createWoodShakeNoiseBuffer(context);
    shakeNoiseBufferRef.current = noiseBuffer;

    let cancelled = false;
    let timeoutId: number | null = null;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }

      playWoodShakeBurst(context, noiseBuffer);
      timeoutId = window.setTimeout(scheduleNext, 190 + Math.random() * 170);
    };

    const begin = () => {
      if (cancelled) {
        return;
      }

      scheduleNext();
    };

    if (context.state === "suspended") {
      void context.resume().then(begin).catch(() => {});
    } else {
      begin();
    }

    shakeAudioStopRef.current = () => {
      cancelled = true;

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  const triggerDoorSuggestion = useCallback((doorId: string) => {
    if (!doorId || typeof window === "undefined" || suggestionCueRef.current) {
      return;
    }

    const mode = suggestionModeCycle[suggestionModeIndexRef.current % suggestionModeCycle.length] ?? "shake";
    suggestionModeIndexRef.current += 1;
    suggestionNonceRef.current += 1;
    const nextCue = {
      doorId,
      nonce: suggestionNonceRef.current,
      mode,
    };
    suggestionCueRef.current = nextCue;
    setSuggestionCue(nextCue);

    stopShakeAudio();
    if (mode === "shake" || mode === "creak") {
      startShakeAudio();
    }
  }, [startShakeAudio, stopShakeAudio]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const intervalId = window.setInterval(() => {
      const isZoomedOut = !focusedDoorId && !interactionLocked && !returnPose;

      if (!isZoomedOut) {
        return;
      }

      if (Date.now() - lastInteractionAtRef.current < idleShakeDelayMs) {
        return;
      }

      if (suggestionCueRef.current) {
        return;
      }

      const doorId = chooseRandomClosedDoor(doorItemIds, openedDoorIds);

      if (!doorId) {
        return;
      }

      triggerDoorSuggestion(doorId);
      lastInteractionAtRef.current = Date.now();
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [doorItemIds, focusedDoorId, interactionLocked, openedDoorIds, returnPose, triggerDoorSuggestion]);

  useEffect(() => {
    if (!suggestionCue) {
      stopShakeAudio();
    }
  }, [stopShakeAudio, suggestionCue]);

  const toggleDoor = (doorId: string) => {
    lastInteractionAtRef.current = Date.now();

    if (suggestionCue) {
      suggestionCueRef.current = null;
      setSuggestionCue(null);
      stopShakeAudio();
    }

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
      setOpenedDoorIds((currentDoors) => ({
        ...currentDoors,
        [doorId]: true,
      }));
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
      setOpenedDoorIds((currentDoors) => ({
        ...currentDoors,
        [doorId]: true,
      }));
      setInteractionLocked(true);
      console.log("[Cabinet] opened object", {
        doorId,
        itemId: currentItem.id,
        title: currentItem.title,
      });
      setFocusedDoorId(doorId);
      setReturnPose(null);
      return;
    }

    setOpenedDoorIds((currentDoors) => ({
      ...currentDoors,
      [doorId]: true,
    }));
    setInteractionLocked(true);
    console.log("[Cabinet] opened object", {
      doorId,
      itemId: currentItem.id,
      title: currentItem.title,
    });
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
            setPendingDoorSwap({
              doorId: closingDoorId,
              nextItemId,
            });
          }
        }

        setClosingDoorId("");
      }

      setInteractionLocked(false);
      lastInteractionAtRef.current = Date.now();

      if (returnReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(returnReleaseFrameRef.current);
      }

      returnReleaseFrameRef.current = window.requestAnimationFrame(() => {
        setReturnPose(null);
        returnReleaseFrameRef.current = null;
      });
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
                suggestionCue={suggestionCue}
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
