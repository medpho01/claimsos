/**
 * Master Options Category Constants
 * Used to reference dropdown categories throughout the app
 * Must match the category values in the database master_options table
 */

export const MASTER_CATEGORIES = {
  HOSPITAL_TYPE: 'hospital_type',
  SPECIALITY: 'speciality',
  DEPARTMENT: 'department',
  // Add more categories as needed
} as const;

export type MasterCategory = typeof MASTER_CATEGORIES[keyof typeof MASTER_CATEGORIES];

/**
 * Category labels for display purposes
 */
export const CATEGORY_LABELS: Record<MasterCategory, string> = {
  [MASTER_CATEGORIES.HOSPITAL_TYPE]: 'Hospital Type',
  [MASTER_CATEGORIES.SPECIALITY]: 'Specialities',
  [MASTER_CATEGORIES.DEPARTMENT]: 'Department',
};

/**
 * Category descriptions for documentation
 */
export const CATEGORY_DESCRIPTIONS: Record<MasterCategory, string> = {
  [MASTER_CATEGORIES.HOSPITAL_TYPE]: 'Type of healthcare facility (Single Specialty, Multi-Specialty, etc.)',
  [MASTER_CATEGORIES.SPECIALITY]: 'Medical specialities offered by the hospital',
  [MASTER_CATEGORIES.DEPARTMENT]: 'Hospital departments',
};
