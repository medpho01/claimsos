import { parentPort, workerData } from 'worker_threads';
import PDFHandler from '../Services/pdfConverter.service.js';

const run = async () => {
  const { imagePaths, finalOutputPath } = workerData;
  const tempRawPath = finalOutputPath.replace('.pdf', '_raw.pdf');
  const pdfHandler = new PDFHandler();

  try {
    await pdfHandler.createPdfFromImages(imagePaths, tempRawPath);
    parentPort?.postMessage({ status: 'success', filePath: tempRawPath });
  } catch (error: any) {
    parentPort?.postMessage({ status: 'error', error: error.message || error });
  }
};

run();