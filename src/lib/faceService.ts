import { normalizeCompareText, normalizeGroupCompare } from './imageUtils.ts';

export const FACE_MATCH_THRESHOLD = 0.56;
const MODEL_URI = '/face-models';

type FaceApiModule = typeof import('@vladmandic/face-api');

let faceApiModulePromise: Promise<FaceApiModule> | null = null;
let modelsLoadedPromise: Promise<FaceApiModule> | null = null;

async function getFaceApi(): Promise<FaceApiModule> {
  if (!faceApiModulePromise) {
    faceApiModulePromise = import('@vladmandic/face-api');
  }
  return faceApiModulePromise;
}

export function loadFaceModels(): Promise<FaceApiModule> {
  if (modelsLoadedPromise) return modelsLoadedPromise;
  modelsLoadedPromise = (async () => {
    const faceapi = await getFaceApi();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URI),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URI),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URI),
    ]);
    return faceapi;
  })().catch((err) => {
    modelsLoadedPromise = null;
    throw err;
  });
  return modelsLoadedPromise;
}

export function preloadFaceModels(): void {
  void loadFaceModels().catch(() => {
    // Silent background warmup; errors surface when camera capture runs
  });
}

export function makeFaceNameKey(firstName: string, lastName: string): string {
  return normalizeCompareText(`${firstName.trim()} ${lastName.trim()}`);
}

function stableSlugHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function makeFaceProfileId(
  firstName: string,
  lastName: string,
  group: string
): string {
  const namePart = makeFaceNameKey(firstName, lastName);
  const groupPart = normalizeGroupCompare(group);
  const raw = `${namePart}_${groupPart}`
    .replace(/['‘’ʻʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const hash = stableSlugHash(`${namePart}|${groupPart}`);
  return `fp_${(raw || 'user').slice(0, 72)}_${hash}`;
}

export function roundDescriptor(raw: Float32Array | number[]): number[] {
  const arr: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    arr.push(Math.round(raw[i] * 100000) / 100000);
  }
  return arr;
}

export async function computeFaceDescriptorHash(
  nameKey: string,
  descriptor: number[]
): Promise<string> {
  const normalized = descriptor.map((n) => Number(n).toFixed(5)).join(',');
  const payload = `${nameKey}|${normalized}`;
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyFaceDescriptorIntegrity(
  nameKey: string,
  descriptor: number[],
  expectedHash: string
): Promise<boolean> {
  if (!Array.isArray(descriptor) || descriptor.length !== 128 || !expectedHash) {
    return false;
  }
  const actual = await computeFaceDescriptorHash(nameKey, descriptor);
  if (actual.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}

export interface ExtractedFaceResult {
  facePhotoUrl: string;
  faceDescriptor: number[];
  score: number;
}

export async function extractFaceFromSource(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<ExtractedFaceResult> {
  const faceapi = await loadFaceModels();

  const srcWidth =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLImageElement
        ? source.naturalWidth || source.width
        : source.width;
  const srcHeight =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLImageElement
        ? source.naturalHeight || source.height
        : source.height;

  if (srcWidth < 40 || srcHeight < 40) {
    throw new Error('Kamera tasviri hali tayyor emas. Biroz kuting va qayta urinib ko‘ring.');
  }

  // Snapshot onto bounded canvas so detection and face crop match the exact same frame
  const maxDim = 640;
  const scale = Math.min(maxDim / srcWidth, maxDim / srcHeight, 1);
  const snapW = Math.max(1, Math.round(srcWidth * scale));
  const snapH = Math.max(1, Math.round(srcHeight * scale));

  const snapshotCanvas = document.createElement('canvas');
  snapshotCanvas.width = snapW;
  snapshotCanvas.height = snapH;
  const snapCtx = snapshotCanvas.getContext('2d');
  if (!snapCtx) {
    throw new Error('Tasvirni qayta ishlash konteksti yaratilmadi.');
  }
  snapCtx.drawImage(source, 0, 0, snapW, snapH);

  const detections = await faceapi
    .detectAllFaces(
      snapshotCanvas,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.42 })
    )
    .withFaceLandmarks(true)
    .withFaceDescriptors();

  if (!detections || detections.length === 0) {
    throw new Error(
      'Yuz aniqlanmadi! Kameraga to‘g‘ri qarab, yuzingiz aniq va yorug‘ ko‘rinishda bo‘lsin.'
    );
  }

  // Pick largest/clearest primary face in front of camera
  const best = [...detections].sort((a, b) => {
    const areaA = a.detection.box.width * a.detection.box.height;
    const areaB = b.detection.box.width * b.detection.box.height;
    return areaB - areaA;
  })[0];

  if (best.detection.box.width < 42 || best.detection.box.height < 42) {
    throw new Error('Yuz kameradan juda uzoqda. Iltimos, kameraga yaqinroq turing.');
  }

  // Crop strictly around face bounding box (+22% padding) to focus on face and keep payload small
  const box = best.detection.box;
  const padX = box.width * 0.22;
  const padTop = box.height * 0.28;
  const padBottom = box.height * 0.18;

  const cropX = Math.max(0, Math.floor(box.x - padX));
  const cropY = Math.max(0, Math.floor(box.y - padTop));
  const cropRight = Math.min(snapW, Math.ceil(box.x + box.width + padX));
  const cropBottom = Math.min(snapH, Math.ceil(box.y + box.height + padBottom));
  const cropW = Math.max(1, cropRight - cropX);
  const cropH = Math.max(1, cropBottom - cropY);

  const outCanvas = document.createElement('canvas');
  const outScale = Math.min(220 / cropW, 260 / cropH, 1);
  outCanvas.width = Math.max(1, Math.round(cropW * outScale));
  outCanvas.height = Math.max(1, Math.round(cropH * outScale));
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) {
    throw new Error('Yuz rasmini saqlashda xatolik yuz berdi.');
  }
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  outCtx.drawImage(
    snapshotCanvas,
    cropX,
    cropY,
    cropW,
    cropH,
    0,
    0,
    outCanvas.width,
    outCanvas.height
  );

  const facePhotoUrl = outCanvas.toDataURL('image/jpeg', 0.74);
  const faceDescriptor = roundDescriptor(best.descriptor);

  return {
    facePhotoUrl,
    faceDescriptor,
    score: best.detection.score,
  };
}

export function compareFaceDescriptors(
  liveDescriptor: number[],
  savedDescriptor: number[]
): { match: boolean; distance: number; similarityPct: number } {
  if (
    !Array.isArray(liveDescriptor) ||
    !Array.isArray(savedDescriptor) ||
    liveDescriptor.length !== 128 ||
    savedDescriptor.length !== 128
  ) {
    return { match: false, distance: 1, similarityPct: 0 };
  }

  let sumSq = 0;
  for (let i = 0; i < 128; i++) {
    const d = liveDescriptor[i] - savedDescriptor[i];
    sumSq += d * d;
  }
  const distance = Math.sqrt(sumSq);
  const match = distance <= FACE_MATCH_THRESHOLD;
  // Map distance 0..0.9 -> intuitive 100%..0% similarity score
  const similarityPct = Math.round(Math.max(0, Math.min(100, (1 - distance / 0.9) * 100)));

  return { match, distance, similarityPct };
}
