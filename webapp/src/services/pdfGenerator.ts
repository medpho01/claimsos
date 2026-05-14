import { DriveFile } from '@/components/modals/PatientPhotosModal/types';
import imageCompression from 'browser-image-compression';
import { jsPDF } from 'jspdf';
import { getBackendOrigin } from './api';
// Concurrency limiter to prevent browser freeze/OOM
const pLimit = (concurrency: number) => {
  const queue: (() => Promise<void>)[] = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()!();
    }
  };

  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        activeCount++;
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          next();
        }
      };

      if (activeCount < concurrency) {
        execute();
      } else {
        queue.push(execute);
      }
    });
  };

  return run;
};

interface ProcessedImage {
  data: string;
  width: number;
  height: number;
}

const processImage = async (file: DriveFile, targetWidth: number, maxMbPerImage: number): Promise<ProcessedImage | null> => {
  if (!file.mimeType.includes("image")) return null;

  try {
    let url = file.webViewLink || "";
    const headers: HeadersInit = {};

    // Prefer proxy link for S3 files to avoid CORS
    if (file.proxyLink) {
      url = file.proxyLink;
      const token = localStorage.getItem("accessToken");
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    const response = await fetch(getBackendOrigin()+url, { headers });
    const blob = await response.blob();

    // Optimize compression: Dynamic size to keep total PDF < 1MB
    const options = {
      maxSizeMB: maxMbPerImage,
      maxWidthOrHeight: targetWidth,
      useWebWorker: true,
      fileType: 'image/jpeg' as const
    };

    const imageFile = new File([blob], file.name, { type: file.mimeType });
    const compressedFile = await imageCompression(imageFile, options);
    const imageData = await imageCompression.getDataUrlFromFile(compressedFile);

    // Get dimensions efficiently
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ data: imageData, width: img.width, height: img.height });
      img.onerror = () => resolve(null);
      img.src = imageData;
    });

  } catch (error) {
    console.error("Processing failed for file:", file.name, error);
    return null;
  }
};

export const generateSmallPDF = async (imageFiles: DriveFile[], patientName: string = "document") => {
  const targetWidth = 1200;
  // Dynamic max size per image to keep total PDF roughly under 1MB
  // Use 0.9MB as a safety buffer for PDF overhead
  const maxMbPerImage = (0.9 / (imageFiles.length || 1));
  const limit = pLimit(3); // Process 3 images at a time

  // 1. Process all images in parallel (with limit)
  const results = await Promise.all(
    imageFiles.map(file => limit(() => processImage(file, targetWidth, maxMbPerImage)))
  );

  // 2. Filter out failures
  const validImages = results.filter((img): img is ProcessedImage => img !== null);

  if (validImages.length === 0) return;

  // 3. Create PDF sequentially to maintain order
  let doc: jsPDF | null = null;

  for (const img of validImages) {
    const calculatedHeight = (img.height * targetWidth) / img.width;

    if (!doc) {
      doc = new jsPDF({
        orientation: targetWidth > calculatedHeight ? 'l' : 'p',
        unit: 'px',
        format: [targetWidth, calculatedHeight]
      });
    } else {
      doc.addPage([targetWidth, calculatedHeight], targetWidth > calculatedHeight ? 'l' : 'p');
    }

    doc.addImage(img.data, 'JPEG', 0, 0, targetWidth, calculatedHeight);
  }

  if (doc) {
    doc.save(`${patientName}.pdf`);
  }
};