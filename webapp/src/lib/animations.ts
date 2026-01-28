import { Variants } from "framer-motion";

/**
 * Fade in animation variant
 */
export const fadeIn: Variants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: { duration: 0.3, ease: "easeOut" },
    },
};

/**
 * Fade in with upward movement
 */
export const fadeInUp: Variants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.4, ease: "easeOut" },
    },
};

/**
 * Slide in from left
 */
export const slideInLeft: Variants = {
    hidden: { opacity: 0, x: -20 },
    visible: {
        opacity: 1,
        x: 0,
        transition: { duration: 0.3, ease: "easeOut" },
    },
};

/**
 * Container for staggered children animations
 */
export const staggerContainer: Variants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: {
            staggerChildren: 0.05,
            delayChildren: 0.1,
        },
    },
};

/**
 * Individual stagger item variant
 */
export const staggerItem: Variants = {
    hidden: { opacity: 0, y: 10 },
    visible: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.3, ease: "easeOut" },
    },
};

/**
 * Table row animation variant with stagger support
 */
export const tableRowVariants: Variants = {
    hidden: { opacity: 0, x: -10 },
    visible: {
        opacity: 1,
        x: 0,
        transition: { duration: 0.25, ease: "easeOut" },
    },
    exit: {
        opacity: 0,
        x: 10,
        transition: { duration: 0.2 },
    },
};

/**
 * Page transition variant
 */
export const pageTransition: Variants = {
    hidden: { opacity: 0, y: 10 },
    visible: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.4, ease: "easeOut" },
    },
    exit: {
        opacity: 0,
        y: -10,
        transition: { duration: 0.3 },
    },
};

/**
 * Card hover animation (for use with whileHover)
 */
export const cardHover = {
    y: -4,
    boxShadow: "0 10px 40px rgba(0, 0, 0, 0.1)",
    transition: { duration: 0.2, ease: "easeOut" },
};

/**
 * Button tap animation (for use with whileTap)
 */
export const buttonTap = {
    scale: 0.97,
    transition: { duration: 0.1 },
};

/**
 * Scale up on hover (for interactive elements)
 */
export const scaleOnHover = {
    scale: 1.02,
    transition: { duration: 0.2 },
};

/**
 * Modal/Dialog animation variant
 */
export const modalVariants: Variants = {
    hidden: {
        opacity: 0,
        scale: 0.95,
        y: 10,
    },
    visible: {
        opacity: 1,
        scale: 1,
        y: 0,
        transition: {
            type: "spring",
            damping: 25,
            stiffness: 300,
        },
    },
    exit: {
        opacity: 0,
        scale: 0.95,
        y: 10,
        transition: { duration: 0.2 },
    },
};

/**
 * Overlay fade animation
 */
export const overlayVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: { duration: 0.2 },
    },
    exit: {
        opacity: 0,
        transition: { duration: 0.2 },
    },
};
