import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import ApiService from '@/services/api';

// Helper function to get API base URL (matches ApiService configuration)
const getApiBaseUrl = () => {
  if (process.env.NODE_ENV === "production") {
    return "/api/v1";
  }
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  return `${protocol}//${hostname}:6001/api/v1`;
};

// Set up PDF.js worker
// Try unpkg CDN first, but you can also copy pdf.worker.min.js from
// node_modules/pdfjs-dist/build/ to public/ folder for local serving
const workerSrc = typeof window !== 'undefined' && window.location.protocol === 'https:'
  ? `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`
  : `/pdf.worker.min.js`; // Falls back to local public folder

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface FilePreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  mimeType: string;
  fileData?: Blob;
  documentId?: string;
  hospitalId?: string;
  shareToken?: string;
  onDownload?: () => void;
}

// Helper function to detect MIME type from file extension
function detectMimeTypeFromFileName(fileName: string, storedMimeType: string): string {
  // If we have a specific MIME type that's not octet-stream, use it
  if (storedMimeType && storedMimeType !== 'application/octet-stream') {
    return storedMimeType;
  }

  // Otherwise, detect from file extension
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  const mimeTypes: { [key: string]: string } = {
    'pdf': 'application/pdf',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'json': 'application/json',
    'xml': 'application/xml',
    'html': 'text/html',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'doc': 'application/msword',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xls': 'application/vnd.ms-excel',
  };

  return mimeTypes[ext] || storedMimeType;
}

export default function FilePreviewModal({
  open,
  onOpenChange,
  fileName,
  mimeType: initialMimeType,
  fileData,
  documentId,
  hospitalId,
  shareToken,
  onDownload,
}: FilePreviewModalProps) {
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectedMimeType, setDetectedMimeType] = useState<string>('');
  const [excelSheets, setExcelSheets] = useState<{ name: string; data: any[][] }[]>([]);
  const [currentSheet, setCurrentSheet] = useState<number>(0);
  const [wordHtml, setWordHtml] = useState<string>('');

  // Use detected MIME type from server, fallback to filename detection, then stored type
  const mimeType = detectedMimeType || detectMimeTypeFromFileName(fileName, initialMimeType);

  const isExcel = mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                  mimeType === 'application/vnd.ms-excel';
  const isWord = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const processExcelFileWithExcelJS = async (blob: Blob) => {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(arrayBuffer);

      const sheets = workbook.worksheets.map((worksheet) => {
        const rows = worksheet.getSheetValues(); // Returns 2D array with index column
        return {
          name: worksheet.name,
          data: (rows.slice(1) as any[][]) // Remove index column added by ExcelJS
        };
      });

      if (sheets.length === 0) {
        setError('Unable to preview Excel file - no sheets found. Please download the file.');
        return;
      }

      setExcelSheets(sheets);
      setCurrentSheet(0);
    } catch (err: any) {
      console.error('Failed to process Excel file:', err);
      setError('Unable to preview this Excel file. Please download it to view the content.');
    }
  };

  const processWordFileWithMammoth = async (blob: Blob) => {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const result = await mammoth.convertToHtml({
        arrayBuffer: arrayBuffer
      });

      if (!result.value || result.value.trim() === '') {
        setError('Unable to preview this Word document. Please download it to view the content.');
        return;
      }

      setWordHtml(result.value); // HTML string

      if (result.messages && result.messages.length > 0) {
        console.warn('Word conversion warnings:', result.messages);
      }
    } catch (err: any) {
      console.error('Failed to process Word file:', err);
      setError('Unable to preview this Word document. Please download it to view the content.');
    }
  };

  useEffect(() => {
    if (!open) return;

    const loadFile = async () => {
      setLoading(true);
      setError(null);
      setCurrentPage(1);
      setExcelSheets([]);
      setCurrentSheet(0);
      setWordHtml('');

      try {
        if (fileData) {
          // Always create URL for download button, even for Excel/Word
          const url = URL.createObjectURL(fileData);
          setPreviewUrl(url);

          // Parse content for Excel and Word previews
          if (isExcel) {
            await processExcelFileWithExcelJS(fileData);
          } else if (isWord) {
            await processWordFileWithMammoth(fileData);
          }
        } else if (documentId && (hospitalId || shareToken)) {
          // Use ApiService for authenticated or public share downloads
          try {
            let blob: Blob;

            if (shareToken) {
              // Public share download
              const apiBaseUrl = getApiBaseUrl();
              const response = await fetch(`${apiBaseUrl}/share/${shareToken}/documents/${documentId}/preview`, {
                method: 'GET',
                headers: { 'Accept': '*/*' }
              });

              if (!response.ok) {
                throw new Error(`Failed to fetch document: ${response.statusText}`);
              }

              blob = await response.blob();
            } else {
              // Authenticated download
              const response = await ApiService.downloadDocument(hospitalId!, documentId);
              blob = response.data;
            }

            // Try to detect MIME type from the blob
            if (blob.type && blob.type !== 'application/octet-stream') {
              setDetectedMimeType(blob.type);
              console.log('Detected MIME type from blob:', blob.type);
            }

            // Always create URL for download button
            const url = URL.createObjectURL(blob);
            setPreviewUrl(url);

            // Check MIME type and route to appropriate parser
            const finalMimeType = blob.type || mimeType;
            const isExcelFile = finalMimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                                finalMimeType === 'application/vnd.ms-excel';
            const isWordFile = finalMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

            if (isExcelFile) {
              await processExcelFileWithExcelJS(blob);
            } else if (isWordFile) {
              await processWordFileWithMammoth(blob);
            }
          } catch (fetchError) {
            console.error('Failed to fetch file:', fetchError);
            setError('Failed to load file: ' + (fetchError instanceof Error ? fetchError.message : String(fetchError)));
          }
        }
      } finally {
        setLoading(false);
      }
    };

    loadFile();
  }, [open, fileData, documentId, hospitalId, initialMimeType, isExcel, isWord]);

  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isText = mimeType.startsWith('text/');

  const handlePdfLoadSuccess = (numPages: number) => {
    setNumPages(numPages);
    setCurrentPage(1);
  };

  const getPreviewContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-96">
          <p className="text-gray-500">Loading preview...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex items-center justify-center h-96">
          <div className="text-center">
            <p className="text-red-600 font-medium mb-2">Failed to load preview</p>
            <p className="text-sm text-gray-500">{error}</p>
          </div>
        </div>
      );
    }

    if (isPdf) {
      // UI Revamp: use the browser's native PDF viewer via <iframe> instead
      // of react-pdf. Avoids worker-bootstrap issues on http://localhost
      // and gives users zoom/pagination/print/download out of the box.
      return (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-white">
          <iframe
            src={previewUrl || undefined}
            title={fileName}
            className="w-full h-[70vh] bg-white"
          />
        </div>
      );
    }

    if (isImage) {
      return (
        <div className="flex items-center justify-center bg-slate-50 dark:bg-slate-800/60 rounded-lg max-h-[70vh]">
          <img
            src={previewUrl}
            alt={fileName}
            className="max-w-full max-h-[70vh] object-contain"
            onError={() => setError('Failed to load image')}
          />
        </div>
      );
    }

    if (isText) {
      return (
        <div className="border rounded-lg bg-gray-50 p-4 max-h-96 overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words text-sm font-mono text-gray-700">
            {previewUrl ? (
              <TextFileContent url={previewUrl} onError={setError} />
            ) : (
              'Unable to load text content'
            )}
          </pre>
        </div>
      );
    }

    if (excelSheets.length > 0) {
      const currentSheetData = excelSheets[currentSheet];
      return (
        <div className="space-y-4">
          {/* Sheet Navigation */}
          {excelSheets.length > 1 && (
            <div className="flex items-center justify-between gap-2 pb-2 border-b">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCurrentSheet(Math.max(0, currentSheet - 1))}
                disabled={currentSheet === 0}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-medium text-gray-700">
                Sheet {currentSheet + 1} of {excelSheets.length}: {currentSheetData.name}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCurrentSheet(Math.min(excelSheets.length - 1, currentSheet + 1))}
                disabled={currentSheet === excelSheets.length - 1}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Excel Table Preview - with horizontal and vertical scroll */}
          <div className="border rounded-lg bg-white max-h-96 overflow-y-auto">
            <div className="overflow-x-auto">
              <table className="border-collapse text-sm min-w-max">
                <tbody>
                  {currentSheetData.data.length === 0 ? (
                    <tr>
                      <td className="p-2 text-center text-gray-500">Sheet is empty</td>
                    </tr>
                  ) : (
                    currentSheetData.data.map((row, rowIdx) => (
                      <tr key={rowIdx} className={rowIdx % 2 === 0 ? 'bg-gray-50' : 'bg-white'}>
                        {row.map((cell, cellIdx) => (
                          <td
                            key={cellIdx}
                            className="border border-gray-200 px-3 py-2 text-gray-700 max-w-xs truncate"
                            title={String(cell || '')}
                          >
                            {cell !== null && cell !== undefined ? String(cell) : ''}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      );
    }

    if (wordHtml) {
      return (
        <div className="border rounded-lg bg-white p-4 max-h-96 overflow-y-auto">
          <div
            className="prose prose-sm max-w-none text-gray-700"
            dangerouslySetInnerHTML={{ __html: wordHtml }}
          />
        </div>
      );
    }

    // For unsupported file types
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-gray-600 font-medium mb-2">Unable to Preview</p>
          <p className="text-sm text-gray-500 mb-4">
            This file type cannot be previewed in the browser.
          </p>
          <p className="text-sm text-gray-500">Use the Download button below to open it with your preferred application.</p>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="flex-shrink-0 border-b px-6 py-4">
          <DialogTitle className="truncate">{fileName}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {getPreviewContent()}
        </div>

        <div className="flex-shrink-0 gap-2 flex px-6 py-4 border-t">
          <Button
            onClick={() => {
              if (onDownload) {
                onDownload();
              } else if (previewUrl) {
                // Fallback: download using the previewUrl blob
                const link = document.createElement('a');
                link.href = previewUrl;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
              }
            }}
            className="flex-1 gap-2"
            disabled={!previewUrl && !onDownload}
          >
            <Download className="h-4 w-4" />
            Download
          </Button>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="flex-1"
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Helper component to load and display text file content
function TextFileContent({ url, onError }: { url: string; onError: (error: string) => void }) {
  const [content, setContent] = useState<string>('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(url)
      .then(res => res.arrayBuffer())
      .then(buffer => {
        try {
          // Try UTF-8 decoding first
          const decoder = new TextDecoder('utf-8', { fatal: true });
          const text = decoder.decode(buffer);

          // Check if the result looks like valid text
          if (text.trim().length === 0) {
            onError('File appears to be empty or binary. Use the Download button to view it with your application.');
            return;
          }

          setContent(text);
          setLoaded(true);
        } catch (e) {
          // If UTF-8 fails, try Latin-1
          try {
            const decoder = new TextDecoder('iso-8859-1');
            const text = decoder.decode(buffer);
            setContent(text);
            setLoaded(true);
          } catch (e2) {
            onError('This file appears to be binary. Use the Download button to view it with your application.');
          }
        }
      })
      .catch(err => {
        onError(`Failed to load text: ${err.message}`);
      });
  }, [url, onError]);

  return <>{loaded ? content : 'Loading...'}</>;

}
