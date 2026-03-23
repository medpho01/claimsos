/**
 * Gemini Flash Extractor — Tier 2 of the Hybrid OCR Pipeline
 * 
 * Uses Gemini 2.0 Flash with type-specific JSON schemas
 * for structured extraction from typed/standard documents.
 * Handles discharge slips, ICP forms, typed prescriptions, admission forms.
 */

import { GoogleGenerativeAI, type Part } from '@google/generative-ai'

// --- Types ---

export interface GeminiExtractionResult {
    success: boolean
    documentType: string
    extractedJson: Record<string, any>
    confidence: number
    costEstimateCents: number
}

// --- Prompts per document type ---

const EXTRACTION_PROMPTS: Record<string, string> = {
    discharge_slip: `You are extracting structured data from Indian hospital discharge summaries.

Extract the following fields into this exact JSON schema:
{
  "patient_name": string | null,
  "age": number | null,
  "gender": "Male" | "Female" | "Other" | null,
  "admission_date": "YYYY-MM-DD" | null,
  "discharge_date": "YYYY-MM-DD" | null,
  "diagnosis_primary": string | null,
  "diagnosis_secondary": string[],
  "procedure_performed": string | null,
  "surgeon_name": string | null,
  "condition_at_discharge": string | null,
  "follow_up_instructions": string[],
  "medications_at_discharge": [{ "name": string, "dose": string, "frequency": string, "duration": string }],
  "confidence": number
}

Rules:
- Expand ALL medical abbreviations (e.g., "AVN" → "Avascular Necrosis", "THR" → "Total Hip Replacement")
- Convert dates to YYYY-MM-DD format regardless of input format
- If a field is not present, use null
- Return ONLY valid JSON, no markdown, no explanation`,

    icp_form: `You are extracting data from Indian hospital Integrated Care Plans (ICP).

Extract into this JSON schema:
{
  "date": "YYYY-MM-DD" | null,
  "day_number": number | null,
  "vitals": { "bp": string | null, "pulse": string | null, "temp": string | null, "spo2": string | null },
  "diet": string | null,
  "activity_level": string | null,
  "medications_given": [{ "name": string, "dose": string, "route": string, "time": string }],
  "assessments": string[],
  "nurse_notes": string | null,
  "doctor_notes": string | null,
  "confidence": number
}

Rules:
- Parse handwritten checkboxes as true/false where applicable
- Convert all dates to YYYY-MM-DD
- Return ONLY valid JSON, no markdown`,

    admission_form: `You are extracting data from Indian hospital admission forms.

Extract into this JSON schema:
{
  "patient_name": string | null,
  "age": number | null,
  "gender": "Male" | "Female" | "Other" | null,
  "phone": string | null,
  "address": string | null,
  "admission_date": "YYYY-MM-DD" | null,
  "admission_type": string | null,
  "referring_doctor": string | null,
  "provisional_diagnosis": string | null,
  "insurance_id": string | null,
  "emergency_contact": string | null,
  "confidence": number
}

Return ONLY valid JSON, no markdown.`,

    prescription: `You are extracting data from Indian hospital prescriptions.

Extract into this JSON schema:
{
  "date": "YYYY-MM-DD" | null,
  "doctor_name": string | null,
  "medications": [{ "name": string, "dose": string, "frequency": string, "route": string | null, "duration": string | null }],
  "special_instructions": string[],
  "confidence": number
}

Rules:
- Expand abbreviations: BD=twice daily, TDS=thrice daily, OD=once daily, SOS=as needed
- "Tab." = Tablet, "Inj." = Injection, "Cap." = Capsule, "Syr." = Syrup
- Return ONLY valid JSON, no markdown`,

    treatment_chart: `You are extracting data from Indian hospital treatment/medication administration charts.

Extract into this JSON schema:
{
  "date": "YYYY-MM-DD" | null,
  "medications": [{ "name": string, "dose": string, "route": string, "frequency": string, "times_given": string[] }],
  "iv_fluids": [{ "name": string, "volume": string, "rate": string }],
  "confidence": number
}

Return ONLY valid JSON, no markdown.`,

    // Fallback prompt for any unrecognized type
    other: `You are extracting structured data from an Indian hospital document.

Extract whatever information you can into this JSON schema:
{
  "document_type_detected": string,
  "patient_name": string | null,
  "date": "YYYY-MM-DD" | null,
  "key_findings": string[],
  "raw_text_summary": string,
  "confidence": number
}

Return ONLY valid JSON, no markdown.`,
}

// --- Service ---

class GeminiExtractorService {
    private genAI: GoogleGenerativeAI
    private model: any

    constructor() {
        const apiKey = process.env.GEMINI_API_KEY
        if (!apiKey) throw new Error('[OCR GeminiExtractor] GEMINI_API_KEY not set')

        this.genAI = new GoogleGenerativeAI(apiKey)
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
    }

    /**
     * Extract structured data from a group of images of the same document type.
     * Images are sent together so the model can cross-reference pages.
     */
    async extractGroup(
        images: { buffer: Buffer; mimeType: string }[],
        documentType: string
    ): Promise<GeminiExtractionResult> {
        const prompt = EXTRACTION_PROMPTS[documentType] || EXTRACTION_PROMPTS['other']

        try {
            const parts: Part[] = [{ text: prompt as string }]

            for (const img of images) {
                parts.push({
                    inlineData: {
                        mimeType: img.mimeType as any,
                        data: img.buffer.toString('base64'),
                    },
                })
            }

            const result = await this.model.generateContent(parts)
            const responseText = result.response.text()

            // Parse JSON
            const jsonStr = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            const extractedJson = JSON.parse(jsonStr)

            const confidence = extractedJson.confidence ?? 0.7

            // Estimate cost: ~$0.001 per page for Gemini Flash
            const costEstimateCents = Math.ceil(images.length * 0.1)

            console.log(`[OCR Gemini] ✓ Extracted ${documentType} (${images.length} pages, confidence: ${confidence})`)

            return {
                success: true,
                documentType,
                extractedJson,
                confidence,
                costEstimateCents,
            }
        } catch (error: any) {
            console.error(`[OCR Gemini] ✗ Extraction failed for ${documentType}:`, error.message)
            return {
                success: false,
                documentType,
                extractedJson: {},
                confidence: 0,
                costEstimateCents: Math.ceil(images.length * 0.1),
            }
        }
    }

    /**
     * Extract from a single image (convenience wrapper).
     */
    async extractSingle(
        buffer: Buffer,
        mimeType: string,
        documentType: string
    ): Promise<GeminiExtractionResult> {
        return this.extractGroup([{ buffer, mimeType }], documentType)
    }
}

export default new GeminiExtractorService()
