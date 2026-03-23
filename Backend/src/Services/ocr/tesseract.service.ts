/**
 * Tesseract Service — Tier 1 of the Hybrid OCR Pipeline (FREE)
 * 
 * Uses tesseract.js for local OCR on clearly printed documents.
 * Applies regex templates for known formats (lab reports, invoices).
 * Auto-escalates to Tier 2 if output quality is too low.
 */

import Tesseract from 'tesseract.js'

// --- Types ---

export interface TesseractResult {
    success: boolean
    escalate: boolean // true = text quality too low, should escalate to Tier 2
    rawText: string
    extractedJson: Record<string, any>
    documentType: string
    confidence: number
}

// --- Regex Templates ---

/**
 * Lab report pattern: test_name  value  unit  (range)  flag
 */
const LAB_RESULT_PATTERN = /^(.+?)\s{2,}([\d.,]+)\s+(\S+)\s+[\(\[]?([\d.,\s\-–]+)[\)\]]?\s*(\w+)?$/gm

/**
 * Patient info patterns
 */
const PATIENT_NAME_PATTERN = /(?:patient\s*(?:name)?|name)\s*[:\-]?\s*([A-Za-z\s.]+)/i
const AGE_PATTERN = /(?:age|years?)\s*[:\-/]?\s*(\d{1,3})/i
const GENDER_PATTERN = /(?:sex|gender)\s*[:\-]?\s*(male|female|m|f|other)/i
const DATE_PATTERN = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/g

/**
 * Invoice patterns
 */
const AMOUNT_PATTERN = /(?:total|amount|net|grand\s*total|bill)\s*[:\-]?\s*(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d{2})?)/i
const GST_PATTERN = /(?:GST|GSTIN)\s*[:\-]?\s*([A-Z0-9]{15})/i
const BATCH_PATTERN = /(?:batch|lot)\s*(?:no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9\-]+)/i

// --- Service ---

class TesseractService {
    private scheduler: Tesseract.Scheduler | null = null
    private initPromise: Promise<void> | null = null

    /**
     * Lazy-initialize a Tesseract worker pool (2 workers for parallelism)
     */
    private async ensureReady(): Promise<void> {
        if (this.scheduler) return
        if (this.initPromise) return this.initPromise

        this.initPromise = (async () => {
            console.log('[OCR Tesseract] Initializing Tesseract workers...')
            this.scheduler = Tesseract.createScheduler()

            // Create 2 workers for parallel processing
            for (let i = 0; i < 2; i++) {
                const worker = await Tesseract.createWorker('eng')
                this.scheduler.addWorker(worker)
            }
            console.log('[OCR Tesseract] ✓ Workers ready')
        })()

        return this.initPromise
    }

    /**
     * Process a single image through Tesseract OCR + template extraction.
     */
    async processImage(
        buffer: Buffer,
        mimeType: string,
        documentType: string
    ): Promise<TesseractResult> {
        await this.ensureReady()

        try {
            const { data } = await this.scheduler!.addJob('recognize', buffer)
            const rawText = data.text || ''
            const ocrConfidence = (data.confidence || 0) / 100

            // Check text quality — if < 50% alphanumeric, escalate
            const alphanumericRatio = this.getAlphanumericRatio(rawText)
            if (alphanumericRatio < 0.5 || rawText.trim().length < 20) {
                console.log(`[OCR Tesseract] Low quality text (${(alphanumericRatio * 100).toFixed(0)}% alphanumeric), escalating`)
                return {
                    success: false,
                    escalate: true,
                    rawText,
                    extractedJson: {},
                    documentType,
                    confidence: ocrConfidence,
                }
            }

            // Apply template extraction based on document type
            let extractedJson: Record<string, any> = {}

            switch (documentType) {
                case 'lab_report':
                    extractedJson = this.extractLabReport(rawText)
                    break
                case 'implant_invoice':
                    extractedJson = this.extractInvoice(rawText)
                    break
                case 'consent_form':
                case 'admission_form':
                    extractedJson = this.extractFormData(rawText)
                    break
                case 'post_op_report':
                    extractedJson = this.extractPostOpReport(rawText)
                    break
                default:
                    extractedJson = this.extractGeneric(rawText)
            }

            // If template extraction yielded almost nothing, escalate
            const fieldCount = Object.keys(extractedJson).filter(k => extractedJson[k] !== null && extractedJson[k] !== '').length
            if (fieldCount < 2) {
                return {
                    success: false,
                    escalate: true,
                    rawText,
                    extractedJson,
                    documentType,
                    confidence: ocrConfidence,
                }
            }

            return {
                success: true,
                escalate: false,
                rawText,
                extractedJson,
                documentType,
                confidence: ocrConfidence,
            }
        } catch (error: any) {
            console.error(`[OCR Tesseract] ✗ OCR failed:`, error.message)
            return {
                success: false,
                escalate: true,
                rawText: '',
                extractedJson: {},
                documentType,
                confidence: 0,
            }
        }
    }

    // --- Template Extractors ---

    private extractLabReport(text: string): Record<string, any> {
        const results: any[] = []
        let match

        // Try structured regex
        const pattern = new RegExp(LAB_RESULT_PATTERN.source, 'gm')
        while ((match = pattern.exec(text)) !== null) {
            results.push({
                test: match[1]!.trim(),
                value: parseFloat(match[2]!.replace(/,/g, '')),
                unit: match[3]!,
                range: match[4]?.trim() || null,
                flag: match[5]?.toLowerCase() || null,
            })
        }

        // Also try simpler line-by-line extraction for value-unit pairs
        if (results.length === 0) {
            const lines = text.split('\n').filter(l => l.trim())
            for (const line of lines) {
                const simpleMatch = line.match(/^(.+?)\s+([\d.]+)\s+(.+)$/)
                if (simpleMatch && simpleMatch[1]!.length > 2) {
                    results.push({
                        test: simpleMatch[1]!.trim(),
                        value: parseFloat(simpleMatch[2]!),
                        unit_and_range: simpleMatch[3]!.trim(),
                    })
                }
            }
        }

        // Extract report name from first few lines
        const firstLines = text.split('\n').slice(0, 5).join(' ')
        const reportName = firstLines.match(/(?:report|test|investigation)\s*[:\-]?\s*(.+)/i)?.[1]?.trim()

        return {
            type: 'lab_report',
            name: reportName || 'Unknown Test',
            results,
            patient_name: text.match(PATIENT_NAME_PATTERN)?.[1]?.trim() || null,
            date: this.extractFirstDate(text),
        }
    }

    private extractInvoice(text: string): Record<string, any> {
        return {
            type: 'implant_invoice',
            total_amount: text.match(AMOUNT_PATTERN)?.[1]?.replace(/,/g, '') || null,
            gst_number: text.match(GST_PATTERN)?.[1] || null,
            batch_number: text.match(BATCH_PATTERN)?.[1] || null,
            date: this.extractFirstDate(text),
            // Try to find implant name
            implant_name: text.match(/(?:implant|product|item|description)\s*[:\-]?\s*(.+)/i)?.[1]?.trim() || null,
        }
    }

    private extractFormData(text: string): Record<string, any> {
        return {
            type: 'form',
            patient_name: text.match(PATIENT_NAME_PATTERN)?.[1]?.trim() || null,
            age: text.match(AGE_PATTERN)?.[1] || null,
            gender: text.match(GENDER_PATTERN)?.[1] || null,
            date: this.extractFirstDate(text),
            phone: text.match(/(?:phone|mobile|contact|mob)\s*[:\-]?\s*(\d{10})/i)?.[1] || null,
        }
    }

    private extractPostOpReport(text: string): Record<string, any> {
        return {
            type: 'post_op_report',
            patient_name: text.match(PATIENT_NAME_PATTERN)?.[1]?.trim() || null,
            date: this.extractFirstDate(text),
            findings: text.length > 50 ? text.substring(0, 2000) : text,
        }
    }

    private extractGeneric(text: string): Record<string, any> {
        return {
            type: 'generic',
            patient_name: text.match(PATIENT_NAME_PATTERN)?.[1]?.trim() || null,
            date: this.extractFirstDate(text),
            raw_content: text.substring(0, 2000),
        }
    }

    // --- Helpers ---

    private getAlphanumericRatio(text: string): number {
        if (!text || text.length === 0) return 0
        const alnum = text.replace(/[^a-zA-Z0-9]/g, '').length
        return alnum / text.length
    }

    private extractFirstDate(text: string): string | null {
        const match = text.match(DATE_PATTERN)
        if (!match) return null

        // Try to parse and format as YYYY-MM-DD
        const dateStr = match[0]
        const parts = dateStr.split(/[\/\-.]/)
        if (parts.length === 3) {
            let [d, m, y] = parts.map(Number) as [number, number, number]
            if (y! < 100) y! += 2000
            // Handle DD/MM/YYYY (Indian format)
            if (d! > 12) [d, m] = [m!, d!]
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
        return dateStr
    }

    /**
     * Gracefully shut down Tesseract workers
     */
    async shutdown(): Promise<void> {
        if (this.scheduler) {
            await this.scheduler.terminate()
            this.scheduler = null
            this.initPromise = null
            console.log('[OCR Tesseract] Workers terminated')
        }
    }
}

export default new TesseractService()
