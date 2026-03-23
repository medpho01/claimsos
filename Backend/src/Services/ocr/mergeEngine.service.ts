/**
 * Merge Engine — Stage 6 of the Hybrid OCR Pipeline
 * 
 * Takes all tier outputs and combines them into one canonical JSON per patient.
 * Handles conflict resolution, deduplication, and completeness scoring.
 */

// --- Types ---

export interface TierOutput {
    tier: string
    documentType: string
    extractedJson: Record<string, any>
    confidence: number
    ipdDocId: string
}

export interface CanonicalEpisode {
    schema_version: string
    meta: {
        generated_at: string
        source_document_count: number
        tier_distribution: Record<string, number>
        total_cost_cents: number
    }
    patient: {
        name: string | null
        age: number | null
        gender: string | null
        phone: string | null
        address: string | null
        insurance_id: string | null
    }
    admission: {
        date: string | null
        type: string | null
        referring_doctor: string | null
        provisional_diagnosis: string | null
    }
    diagnosis: {
        primary: string | null
        secondary: string[]
    }
    treatment: {
        procedure_name: string | null
        procedure_date: string | null
        surgeon: string | null
        assistant_surgeon: string | null
        anaesthetist: string | null
        anaesthesia_type: string | null
        surgical_approach: string | null
        procedure_details: string | null
        blood_loss_ml: number | null
        duration_minutes: number | null
        complications: string | null
        post_op_instructions: string[]
    }
    implant: {
        name: string | null
        type: string | null
        size: string | null
        batch_no: string | null
        cost: number | null
    } | null
    investigations: Array<{
        name: string
        results: any[]
        date: string | null
    }>
    medications: {
        during_stay: Array<{
            date: string | null
            medications: any[]
        }>
        at_discharge: any[]
    }
    daily_progress: Array<{
        date: string | null
        day_number: number | null
        vitals: any
        diet: string | null
        activity_level: string | null
        nurse_notes: string | null
        doctor_notes: string | null
    }>
    discharge: {
        date: string | null
        condition_at_discharge: string | null
        follow_up_instructions: string[]
    }
    financials: {
        total_bill: number | null
        gst_number: string | null
    }
    clinical_photos: Array<{
        image_type: string
        anatomical_region: string
        description: string
        findings: string[]
        concerns: string[] | null
    }>
    conflicts: Array<{
        field: string
        values: Array<{ source: string; value: any; confidence: number }>
        resolved_value: any
    }>
}

// --- Tier priority (higher = more trustworthy) ---
const TIER_PRIORITY: Record<string, number> = {
    tier_3_gpt4o: 4,
    tier_2_gemini: 3,
    tier_1_tesseract: 2,
    tier_4_photo: 1,
}

// --- Required fields for completeness scoring ---
const REQUIRED_FIELDS = ['patient.name', 'admission.date', 'discharge.date', 'diagnosis.primary', 'treatment.procedure_name']
const IMPORTANT_FIELDS = ['investigations', 'medications.at_discharge', 'financials.total_bill', 'discharge.condition_at_discharge', 'treatment.surgeon']
const NICE_TO_HAVE_FIELDS = ['clinical_photos', 'diagnosis.secondary', 'implant', 'daily_progress']

// --- Service ---

class MergeEngineService {
    /**
     * Merge all tier outputs into a single canonical JSON.
     */
    merge(results: TierOutput[], totalCostCents: number): CanonicalEpisode {
        console.log(`[OCR Merge] Merging ${results.length} document results...`)

        // Group results by what section they contribute to
        const byType = this.groupBy(results, r => r.documentType)

        const conflicts: CanonicalEpisode['conflicts'] = []

        // Build each section
        const patient = this.buildPatient(byType, conflicts)
        const admission = this.buildAdmission(byType, conflicts)
        const diagnosis = this.buildDiagnosis(byType, conflicts)
        const treatment = this.buildTreatment(byType, conflicts)
        const implant = this.buildImplant(byType)
        const investigations = this.buildInvestigations(byType)
        const medications = this.buildMedications(byType)
        const dailyProgress = this.buildDailyProgress(byType)
        const discharge = this.buildDischarge(byType, conflicts)
        const financials = this.buildFinancials(byType)
        const clinicalPhotos = this.buildClinicalPhotos(byType)

        // Tier distribution
        const tierDistribution: Record<string, number> = {}
        for (const r of results) {
            tierDistribution[r.tier] = (tierDistribution[r.tier] || 0) + 1
        }

        const canonical: CanonicalEpisode = {
            schema_version: 'v1',
            meta: {
                generated_at: new Date().toISOString(),
                source_document_count: results.length,
                tier_distribution: tierDistribution,
                total_cost_cents: totalCostCents,
            },
            patient,
            admission,
            diagnosis,
            treatment,
            implant,
            investigations,
            medications,
            daily_progress: dailyProgress,
            discharge,
            financials,
            clinical_photos: clinicalPhotos,
            conflicts,
        }

        if (conflicts.length > 0) {
            console.log(`[OCR Merge] ⚠ ${conflicts.length} conflict(s) detected and resolved`)
        }

        console.log(`[OCR Merge] ✓ Canonical JSON assembled`)
        return canonical
    }

    /**
     * Compute completeness score (0-100).
     */
    computeCompletenessScore(episode: CanonicalEpisode): number {
        let score = 0
        let maxScore = 0

        // Required fields (weight: 10 each)
        for (const field of REQUIRED_FIELDS) {
            maxScore += 10
            if (this.getNestedValue(episode, field)) score += 10
        }

        // Important fields (weight: 5 each)
        for (const field of IMPORTANT_FIELDS) {
            maxScore += 5
            const val = this.getNestedValue(episode, field)
            if (val && (!Array.isArray(val) || val.length > 0)) score += 5
        }

        // Nice-to-have fields (weight: 2 each)
        for (const field of NICE_TO_HAVE_FIELDS) {
            maxScore += 2
            const val = this.getNestedValue(episode, field)
            if (val && (!Array.isArray(val) || val.length > 0)) score += 2
        }

        return Math.round((score / maxScore) * 100)
    }

    // --- Section Builders ---

    private buildPatient(byType: Map<string, TierOutput[]>, conflicts: CanonicalEpisode['conflicts']) {
        const sources = [
            ...(byType.get('admission_form') || []),
            ...(byType.get('discharge_slip') || []),
            ...(byType.get('consent_form') || []),
        ]

        return {
            name: this.resolveField(sources, 'patient_name', conflicts, 'patient.name'),
            age: this.resolveField(sources, 'age', conflicts, 'patient.age'),
            gender: this.resolveField(sources, 'gender', conflicts, 'patient.gender'),
            phone: this.resolveField(sources, 'phone', conflicts, 'patient.phone'),
            address: this.resolveField(sources, 'address', conflicts, 'patient.address'),
            insurance_id: this.resolveField(sources, 'insurance_id', conflicts, 'patient.insurance_id'),
        }
    }

    private buildAdmission(byType: Map<string, TierOutput[]>, conflicts: CanonicalEpisode['conflicts']) {
        const sources = [
            ...(byType.get('admission_form') || []),
            ...(byType.get('discharge_slip') || []),
        ]

        return {
            date: this.resolveField(sources, 'admission_date', conflicts, 'admission.date'),
            type: this.resolveField(sources, 'admission_type', conflicts, 'admission.type'),
            referring_doctor: this.resolveField(sources, 'referring_doctor', conflicts, 'admission.referring_doctor'),
            provisional_diagnosis: this.resolveField(sources, 'provisional_diagnosis', conflicts, 'admission.provisional_diagnosis'),
        }
    }

    private buildDiagnosis(byType: Map<string, TierOutput[]>, conflicts: CanonicalEpisode['conflicts']) {
        const sources = [
            ...(byType.get('discharge_slip') || []),
            ...(byType.get('ot_note') || []),
        ]

        const secondary: string[] = []
        for (const s of sources) {
            const arr = s.extractedJson.diagnosis_secondary
            if (Array.isArray(arr)) secondary.push(...arr)
        }

        return {
            primary: this.resolveField(sources, 'diagnosis_primary', conflicts, 'diagnosis.primary'),
            secondary: [...new Set(secondary)], // Deduplicate
        }
    }

    private buildTreatment(byType: Map<string, TierOutput[]>, conflicts: CanonicalEpisode['conflicts']) {
        const otSources = byType.get('ot_note') || []
        const dischargeSources = byType.get('discharge_slip') || []
        const allSources = [...otSources, ...dischargeSources]

        return {
            procedure_name: this.resolveField(allSources, 'procedure_name', conflicts, 'treatment.procedure_name')
                || this.resolveField(allSources, 'procedure_performed', conflicts, 'treatment.procedure_name'),
            procedure_date: this.resolveField(allSources, 'procedure_date', conflicts, 'treatment.procedure_date'),
            surgeon: this.resolveField(allSources, 'surgeon', conflicts, 'treatment.surgeon')
                || this.resolveField(allSources, 'surgeon_name', conflicts, 'treatment.surgeon'),
            assistant_surgeon: this.resolveField(otSources, 'assistant_surgeon', conflicts, 'treatment.assistant_surgeon'),
            anaesthetist: this.resolveField(otSources, 'anaesthetist', conflicts, 'treatment.anaesthetist'),
            anaesthesia_type: this.resolveField(otSources, 'anaesthesia_type', conflicts, 'treatment.anaesthesia_type'),
            surgical_approach: this.resolveField(otSources, 'surgical_approach', conflicts, 'treatment.surgical_approach'),
            procedure_details: this.resolveField(otSources, 'procedure_details', conflicts, 'treatment.procedure_details'),
            blood_loss_ml: this.resolveField(otSources, 'blood_loss_ml', conflicts, 'treatment.blood_loss_ml'),
            duration_minutes: this.resolveField(otSources, 'duration_minutes', conflicts, 'treatment.duration_minutes'),
            complications: this.resolveField(otSources, 'complications', conflicts, 'treatment.complications'),
            post_op_instructions: this.collectArrayField(allSources, 'post_op_instructions'),
        }
    }

    private buildImplant(byType: Map<string, TierOutput[]>) {
        const sources = [
            ...(byType.get('ot_note') || []),
            ...(byType.get('implant_invoice') || []),
        ]

        let implant: any = null
        for (const s of sources) {
            const data = s.extractedJson.implant_used || s.extractedJson
            if (data?.implant_name || data?.name) {
                implant = {
                    name: data.implant_name || data.name || null,
                    type: data.type || null,
                    size: data.size || null,
                    batch_no: data.batch_no || data.batch_number || null,
                    cost: data.total_amount ? parseFloat(String(data.total_amount).replace(/,/g, '')) : null,
                }
                break
            }
        }

        return implant
    }

    private buildInvestigations(byType: Map<string, TierOutput[]>) {
        const sources = byType.get('lab_report') || []
        return sources
            .filter(s => s.extractedJson.results || s.extractedJson.name)
            .map(s => ({
                name: s.extractedJson.name || 'Unknown Test',
                results: s.extractedJson.results || [],
                date: s.extractedJson.date || null,
            }))
    }

    private buildMedications(byType: Map<string, TierOutput[]>) {
        const prescriptionSources = [
            ...(byType.get('prescription') || []),
            ...(byType.get('treatment_chart') || []),
        ]
        const dischargeSources = byType.get('discharge_slip') || []

        const duringStay = prescriptionSources
            .filter(s => s.extractedJson.medications)
            .map(s => ({
                date: s.extractedJson.date || null,
                medications: s.extractedJson.medications || [],
            }))

        let atDischarge: any[] = []
        for (const s of dischargeSources) {
            if (s.extractedJson.medications_at_discharge) {
                atDischarge = s.extractedJson.medications_at_discharge
                break
            }
        }

        return { during_stay: duringStay, at_discharge: atDischarge }
    }

    private buildDailyProgress(byType: Map<string, TierOutput[]>) {
        const sources = byType.get('icp_form') || []
        return sources.map(s => ({
            date: s.extractedJson.date || null,
            day_number: s.extractedJson.day_number || null,
            vitals: s.extractedJson.vitals || null,
            diet: s.extractedJson.diet || null,
            activity_level: s.extractedJson.activity_level || null,
            nurse_notes: s.extractedJson.nurse_notes || null,
            doctor_notes: s.extractedJson.doctor_notes || null,
        }))
    }

    private buildDischarge(byType: Map<string, TierOutput[]>, conflicts: CanonicalEpisode['conflicts']) {
        const sources = byType.get('discharge_slip') || []

        return {
            date: this.resolveField(sources, 'discharge_date', conflicts, 'discharge.date'),
            condition_at_discharge: this.resolveField(sources, 'condition_at_discharge', conflicts, 'discharge.condition'),
            follow_up_instructions: this.collectArrayField(sources, 'follow_up_instructions'),
        }
    }

    private buildFinancials(byType: Map<string, TierOutput[]>) {
        const sources = [
            ...(byType.get('implant_invoice') || []),
            ...(byType.get('discharge_slip') || []),
        ]

        let totalBill: number | null = null
        let gstNumber: string | null = null

        for (const s of sources) {
            if (s.extractedJson.total_amount && !totalBill) {
                totalBill = parseFloat(String(s.extractedJson.total_amount).replace(/,/g, ''))
            }
            if (s.extractedJson.gst_number && !gstNumber) {
                gstNumber = s.extractedJson.gst_number
            }
        }

        return { total_bill: totalBill, gst_number: gstNumber }
    }

    private buildClinicalPhotos(byType: Map<string, TierOutput[]>) {
        const sources = [
            ...(byType.get('clinical_photo') || []),
            ...(byType.get('xray') || []),
        ]

        return sources
            .filter(s => s.extractedJson.description)
            .map(s => ({
                image_type: s.extractedJson.image_type || 'clinical_photo',
                anatomical_region: s.extractedJson.anatomical_region || 'Unknown',
                description: s.extractedJson.description || '',
                findings: s.extractedJson.findings || [],
                concerns: s.extractedJson.concerns || null,
            }))
    }

    // --- Conflict Resolution ---

    /**
     * Resolve a field across multiple sources:
     * 1. Highest confidence wins
     * 2. Higher tier wins on tie
     * 3. Log conflict if values differ
     */
    private resolveField(
        sources: TierOutput[],
        fieldName: string,
        conflicts: CanonicalEpisode['conflicts'],
        canonicalPath: string
    ): any {
        const candidates: Array<{ value: any; confidence: number; tier: string; source: string }> = []

        for (const s of sources) {
            const value = s.extractedJson[fieldName]
            if (value !== null && value !== undefined && value !== '') {
                candidates.push({
                    value,
                    confidence: s.confidence,
                    tier: s.tier,
                    source: `${s.documentType} (${s.tier})`,
                })
            }
        }

        if (candidates.length === 0) return null
        if (candidates.length === 1) return candidates[0]!.value

        // Sort: highest confidence first, then by tier priority
        candidates.sort((a, b) => {
            if (b.confidence !== a.confidence) return b.confidence - a.confidence
            return (TIER_PRIORITY[b.tier] || 0) - (TIER_PRIORITY[a.tier] || 0)
        })

        // Check for contradictions
        const uniqueValues = new Set(candidates.map(c => JSON.stringify(c.value)))
        if (uniqueValues.size > 1) {
            conflicts.push({
                field: canonicalPath,
                values: candidates.map(c => ({
                    source: c.source,
                    value: c.value,
                    confidence: c.confidence,
                })),
                resolved_value: candidates[0]!.value,
            })
        }

        return candidates[0]!.value
    }

    private collectArrayField(sources: TierOutput[], fieldName: string): string[] {
        const allItems: string[] = []
        for (const s of sources) {
            const arr = s.extractedJson[fieldName]
            if (Array.isArray(arr)) allItems.push(...arr)
        }
        return [...new Set(allItems)] // Deduplicate
    }

    // --- Helpers ---

    private groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
        const map = new Map<string, T[]>()
        for (const item of items) {
            const key = keyFn(item)
            if (!map.has(key)) map.set(key, [])
            map.get(key)!.push(item)
        }
        return map
    }

    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((current, key) => current?.[key], obj)
    }
}

export default new MergeEngineService()
