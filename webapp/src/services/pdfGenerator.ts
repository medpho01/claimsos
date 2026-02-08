import { DriveFile } from '@/components/modals/PatientPhotosModal/types';
import imageCompression from 'browser-image-compression';
import { jsPDF } from 'jspdf';
import apiService from "./api";

export const generateSmallPDF = async (imageFiles: DriveFile[],patientName:string="document") => {
  let doc: jsPDF | null = null;
  const maxMbPerImage = (0.9 / imageFiles.length);
  const targetWidth = 1200; 

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    if (!file.mimeType.includes("image")) continue;

    try {
      const response = await fetch(apiService.getThumbnailUrl(file.id));
      const blob = await response.blob();

      const options = {
        maxSizeMB: maxMbPerImage,
        maxWidthOrHeight: targetWidth,
        useWebWorker: true,
        fileType: 'image/jpeg' as const
      };

      const imageFile = new File([blob], file.name, { type: file.mimeType });
      const compressedFile = await imageCompression(imageFile, options);
      const imageData = await imageCompression.getDataUrlFromFile(compressedFile);

      const dimensions: { width: number; height: number } = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.width, height: img.height });
        img.src = imageData;
      });

      const calculatedHeight = (dimensions.height * targetWidth) / dimensions.width;

      if (!doc) {
        doc = new jsPDF({
          orientation: targetWidth > calculatedHeight ? 'l' : 'p',
          unit: 'px',
          format: [targetWidth, calculatedHeight]
        });
      } else {
        doc.addPage([targetWidth, calculatedHeight], targetWidth > calculatedHeight ? 'l' : 'p');
      }

      doc.addImage(imageData, 'JPEG', 0, 0, targetWidth, calculatedHeight);
    } catch (error) {
      console.error("Processing failed for file:", file.name, error);
    }
  }

  if (doc) {
    doc.save(`${patientName}.pdf`);
  }
};