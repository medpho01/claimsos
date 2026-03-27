import React, { useRef, useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, FileText, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface FileWithMetadata {
    file: File;
    name: string;
}

interface DoctorDocsUploadModalProps {
    isOpen: boolean;
    onClose: () => void;
    onUpload: (files: File[], customNames: string[]) => Promise<void>;
    isUploading: boolean;
    doctorName?: string;
}

export const DoctorDocsUploadModal: React.FC<DoctorDocsUploadModalProps> = ({
    isOpen,
    onClose,
    onUpload,
    isUploading,
    doctorName
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedFiles, setSelectedFiles] = useState<FileWithMetadata[]>([]);

    useEffect(() => {
        if (!isOpen) {
            setSelectedFiles([]);
        }
    }, [isOpen]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const newFiles = Array.from(e.target.files).map(file => ({
                file,
                name: file.name // Default to original file name
            }));
            setSelectedFiles(prev => [...prev, ...newFiles]);
        }
    };

    const removeFile = (index: number) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    };

    const updateFileName = (index: number, newName: string) => {
        setSelectedFiles(prev => prev.map((item, i) => i === index ? { ...item, name: newName } : item));
    };

    const handleUpload = () => {
        if (selectedFiles.length === 0) return;
        const files = selectedFiles.map(sf => sf.file);
        const customNames = selectedFiles.map(sf => sf.name);
        onUpload(files, customNames);
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Upload Documents for Dr. {doctorName}</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2 pt-2">
                        <Label>Select File(s)</Label>
                        <div className="flex gap-2 items-center">
                            <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                                Browse Files
                            </Button>
                            <span className="text-sm text-slate-500">
                                {selectedFiles.length} file(s) selected
                            </span>
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            onChange={handleFileChange}
                            className="hidden"
                        />
                    </div>

                    {selectedFiles.length > 0 && (
                        <div className="max-h-60 overflow-y-auto space-y-3 mt-4 pr-2">
                            {selectedFiles.map((item, i) => (
                                <div key={i} className="bg-slate-50 p-3 rounded-md border border-slate-200 space-y-2">
                                    <div className="flex items-center justify-between text-sm">
                                        <div className="flex items-center gap-2 overflow-hidden">
                                            <FileText className="h-4 w-4 shrink-0 text-slate-500" />
                                            <span className="truncate font-medium text-slate-700">{item.file.name}</span>
                                            <span className="text-xs text-slate-400 shrink-0">
                                                {(item.file.size / 1024).toFixed(0)} KB
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            className="text-slate-400 hover:text-red-500 transition-colors"
                                            onClick={() => removeFile(i)}
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    </div>
                                    <div className="pt-1">
                                        <Label className="text-xs text-slate-500 mb-1 block">Document Name / Type</Label>
                                        <Input
                                            value={item.name}
                                            onChange={(e) => updateFileName(i, e.target.value)}
                                            placeholder="e.g. Aadhar Card, Degree Certificate"
                                            className="h-8 text-sm"
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={isUploading}>Cancel</Button>
                    <Button onClick={handleUpload} disabled={isUploading || selectedFiles.length === 0}>
                        {isUploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                        {isUploading ? "Uploading..." : "Upload Documents"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
