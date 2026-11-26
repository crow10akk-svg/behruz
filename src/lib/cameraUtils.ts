export type CameraFacingMode = 'user' | 'environment';

export async function openCameraStream(
  facingMode: CameraFacingMode,
  idealSize: { width: number; height: number } = { width: 1280, height: 960 }
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Brauzer kameraga ulanishni qo‘llab-quvvatlamaydi.');
  }

  const attempts: MediaStreamConstraints[] = [
    {
      video: {
        facingMode: { exact: facingMode },
        width: { ideal: idealSize.width },
        height: { ideal: idealSize.height },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: idealSize.width },
        height: { ideal: idealSize.height },
      },
      audio: false,
    },
    {
      video: { facingMode },
      audio: false,
    },
    {
      video: true,
      audio: false,
    },
  ];

  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') {
        throw err;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Kamerani ishga tushirib bo‘lmadi.');
}
