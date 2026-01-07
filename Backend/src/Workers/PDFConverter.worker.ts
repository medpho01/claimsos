import { parentPort, workerData } from 'worker_threads';
import PDFHandler from '../Services/pdfConverter.service.js';
import { promises as fs } from 'fs';

const run = async () => {
  const { imagePaths, finalOutputPath } = workerData;
  const tempRawPath = finalOutputPath.replace('.pdf', '_raw.pdf');
  const pdfHandler = new PDFHandler();

  try {
    await pdfHandler.createPdfFromImages(imagePaths, tempRawPath);
    await pdfHandler.compressPdf(tempRawPath, finalOutputPath);
    await fs.unlink(tempRawPath);

    parentPort?.postMessage({ status: 'success', filePath: finalOutputPath });
  } catch (error: any) {
    parentPort?.postMessage({ status: 'error', error: error.message || error });
  }
};

run();