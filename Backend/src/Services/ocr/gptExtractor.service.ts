/**
 * GPT-4o Vision Extractor — Tier 3 of the Hybrid OCR Pipeline (Premium)
 * 
 * Handles the hardest documents: handwritten OT notes, messy prescriptions,
 * treatment charts, low-quality scans. Uses GPT-4o Vision for best-in-class
 * handwriting recognition and clinical context understanding.
 */

import OpenAI from 'openai'

// --- Types ---

export interface GPTExtractionResult {
    success: boolean
    documentType: string
    extractedJson: Record<string, any>
    confidence: number
    costEstimateCents: number
}

// --- Prompts ---

const EXTRACTION_PROMPTS: Record<string, string> = {
    ot_note: `You are a medical transcriptionist specializing in Indian orthopedic surgery OT notes.

These are Operation Theatre notes written by surgeons during/after surgery.
They are typically handwritten on standard OT record forms.

Extract into this exact JSON:
{
  "procedure_name": string | null,
  "procedure_date": "YYYY-MM-DD" | null,
  "surgeon": string | null,
  "assistant_surgeon": string | null,
  "anaesthetist": string | null,
  "anaesthesia_type": "General" | "Spinal" | "Epidural" | "Regional" | "Local" | null,
  "patient_position": string | null,
  "surgical_approach": string | null,
  "procedure_details": string | null,
  "implant_used": { "name": string, "type": string, "size": string, "batch_no": string } | null,
  "blood_loss_ml": number | null,
  "duration_minutes": number | null,
  "complications": string | null,
  "post_op_instructions": string[],
  "confidence": number
}

IMPORTANT Indian medical context:
- Common abbreviations: THR=Total Hip Replacement, TKR=Total Knee Replacement, ORIF=Open Reduction Internal Fixation, CRIF=Closed Reduction Internal Fixation, DHS=Dynamic Hip Screw, PHILOS=Proximal Humerus Internal Locking System
- "GA" = General Anaesthesia, "SA" = Spinal Anaesthesia, "RA" = Regional Anaesthesia
- Surgeons may write in mix of English + Hindi/regional abbreviations
- "B/L" = Bilateral, "Rt" = Right, "Lt" = Left, "NOF" = Neck of Femur
- "AVN" = Avascular Necrosis in orthopedic context

Return ONLY valid JSON, no markdown, no explanation.`,

    prescription: `You are extracting data from handwritten Indian hospital prescriptions.

Extract into this JSON:
{
  "date": "YYYY-MM-DD" | null,
  "doctor_name": string | null,
  "medications": [{ "name": string, "dose": string, "frequency": string, "route": string | null, "duration": string | null }],
  "special_instructions": string[],
  "confidence": number
}

Abbreviations: BD=twice daily, TDS=thrice daily, OD=once daily, QID=four times daily, SOS=as needed, HS=at bedtime, AC=before food, PC=after food
"Tab." = Tablet, "Inj." = Injection, "Cap." = Capsule, "Syr." = Syrup, "Neb." = Nebulization
Routes: PO=oral, IV=intravenous, IM=intramuscular, SC=subcutaneous

Return ONLY valid JSON, no markdown.`,

    treatment_chart: `You are extracting data from handwritten Indian hospital treatment/medication administration charts.

Extract into this JSON:
{
  "date": "YYYY-MM-DD" | null,
  "medications": [{ "name": string, "dose": string, "route": string, "frequency": string, "times_given": string[] }],
  "iv_fluids": [{ "name": string, "volume": string, "rate": string }],
  "vitals": { "bp": string | null, "pulse": string | null, "temp": string | null, "spo2": string | null },
  "confidence": number
}

Return ONLY valid JSON, no markdown.`,

    other: `You are extracting structured data from a complex Indian hospital document that may contain handwriting.

Extract whatever information you can into:
{
  "document_type_detected": string,
  "patient_name": string | null,
  "date": "YYYY-MM-DD" | null,
  "key_findings": string[],
  "detailed_content": string,
  "confidence": number
}

Return ONLY valid JSON, no markdown.`,
}

// --- Service ---

class GPTExtractorService {
    private client: OpenAI

    constructor() {
        const apiKey = process.env.OPENAI_API_KEY
        if (!apiKey) throw new Error('[OCR GPT4o] OPENAI_API_KEY not set')

        this.client = new OpenAI({ apiKey })
    }

    /**
     * Extract structured data from complex/handwritten documents.
     * Sends images to GPT-4o Vision with document-type-specific prompts.
     */
    async extractGroup(
        images: { buffer: Buffer; mimeType: string }[],
        documentType: string
    ): Promise<GPTExtractionResult> {
        const prompt = EXTRACTION_PROMPTS[documentType] || EXTRACTION_PROMPTS['other']

        const maxRetries = 3
        let lastError = ''

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Build message with images
                const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
                    { type: 'text', text: attempt > 1 ? `${prompt}\n\nIMPORTANT: Return ONLY a single valid JSON object. No other text.` : prompt! },
                ]

                for (const img of images) {
                    content.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${img.mimeType};base64,${img.buffer.toString('base64')}`,
                            detail: 'high',
                        },
                    })
                }

                const response = await this.client.chat.completions.create({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content }],
                    max_tokens: 4096,
                    temperature: 0.1, // Low temperature for consistent extraction
                })

                const responseText = response.choices[0]?.message?.content || ''

                // Parse JSON
                const jsonStr = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
                const extractedJson = JSON.parse(jsonStr)

                const confidence = extractedJson.confidence ?? 0.8

                // Estimate cost: ~5 cents per page for GPT-4o Vision
                const costEstimateCents = images.length * 5

                // Track token usage
                const tokensUsed = response.usage?.total_tokens || 0
                console.log(`[OCR GPT4o] ✓ Extracted ${documentType} (${images.length} pages, ${tokensUsed} tokens, confidence: ${confidence})`)

                return {
                    success: true,
                    documentType,
                    extractedJson,
                    confidence,
                    costEstimateCents,
                }
            } catch (error: any) {
                lastError = error.message
                console.warn(`[OCR GPT4o] Attempt ${attempt}/${maxRetries} failed for ${documentType}: ${error.message}`)

                if (attempt < maxRetries) {
                    // Exponential backoff: 2s, 4s, 8s
                    await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, attempt - 1)))
                }
            }
        }

        console.error(`[OCR GPT4o] ✗ All ${maxRetries} attempts failed for ${documentType}: ${lastError}`)
        return {
            success: false,
            documentType,
            extractedJson: {},
            confidence: 0,
            costEstimateCents: images.length * 5,
        }
    }

    /**
     * Extract from a single image (convenience wrapper).
     */
    async extractSingle(
        buffer: Buffer,
        mimeType: string,
        documentType: string
    ): Promise<GPTExtractionResult> {
        return this.extractGroup([{ buffer, mimeType }], documentType)
    }
}

export default new GPTExtractorService()
