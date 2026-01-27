/**
 * Utility functions for HospitalDetailsPage
 */

/**
 * Get initials from first and last name
 */
export const getInitials = (firstName: string, lastName: string): string => {
    return `${firstName?.charAt(0) || ""}${lastName?.charAt(0) || ""}`.toUpperCase();
};

/**
 * Format date string to localized format
 */
export const formatDate = (dateString?: string): string => {
    if (!dateString) return "—";
    return new Date(dateString).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
};

/**
 * Normalize phone number - remove leading zeros and limit to 10 digits
 */
export const normalizePhone = (phone: string): string => {
    return phone.replace(/^0+/, '').slice(0, 10);
};
