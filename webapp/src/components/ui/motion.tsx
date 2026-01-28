"use client";

import React from "react";
import { motion, HTMLMotionProps, AnimatePresence, type Easing } from "framer-motion";
import { cn } from "@/lib/utils";
import {
    fadeInUp,
    pageTransition,
    staggerContainer,
    staggerItem,
    buttonTap,
} from "@/lib/animations";

/**
 * Animated page wrapper with enter/exit transitions
 */
export const AnimatedPage: React.FC<{
    children: React.ReactNode;
    className?: string;
}> = ({ children, className }) => (
    <motion.div
        initial="hidden"
        animate="visible"
        exit="exit"
        variants={pageTransition}
        className={className}
    >
        {children}
    </motion.div>
);

/**
 * Animated card with hover lift effect
 */
export const MotionCard = React.forwardRef<
    HTMLDivElement,
    HTMLMotionProps<"div"> & { enableHover?: boolean }
>(({ className, enableHover = true, children, ...props }, ref) => (
    <motion.div
        ref={ref}
        initial="hidden"
        animate="visible"
        variants={fadeInUp}
        whileHover={enableHover ? {
            y: -4,
            boxShadow: "0 10px 40px rgba(0, 0, 0, 0.1)",
            transition: { duration: 0.2, ease: "easeOut" as Easing },
        } : undefined}
        className={cn(
            "rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow",
            className
        )}
        {...props}
    >
        {children}
    </motion.div>
));
MotionCard.displayName = "MotionCard";

/**
 * Animated button with tap feedback
 */
export const MotionButton = React.forwardRef<
    HTMLButtonElement,
    HTMLMotionProps<"button">
>(({ className, children, ...props }, ref) => (
    <motion.button
        ref={ref}
        whileTap={buttonTap}
        whileHover={{ scale: 1.02 }}
        transition={{ duration: 0.2 }}
        className={className}
        {...props}
    >
        {children}
    </motion.button>
));
MotionButton.displayName = "MotionButton";

/**
 * Animated table row with stagger support
 */
export const MotionTableRow = React.forwardRef<
    HTMLTableRowElement,
    HTMLMotionProps<"tr"> & { index?: number }
>(({ className, children, index = 0, ...props }, ref) => (
    <motion.tr
        ref={ref}
        variants={staggerItem}
        initial="hidden"
        animate="visible"
        exit="exit"
        custom={index}
        className={cn(
            "cursor-pointer transition-colors hover:bg-muted/50",
            className
        )}
        whileHover={{
            backgroundColor: "rgba(0, 0, 0, 0.02)",
            transition: { duration: 0.15 },
        }}
        {...props}
    >
        {children}
    </motion.tr>
));
MotionTableRow.displayName = "MotionTableRow";

/**
 * Stagger container for animating lists
 */
export const StaggerContainer: React.FC<{
    children: React.ReactNode;
    className?: string;
    as?: keyof React.JSX.IntrinsicElements;
}> = ({ children, className, as = "div" }) => {
    const Component = motion[as as keyof typeof motion] as any;
    return (
        <Component
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className={className}
        >
            {children}
        </Component>
    );
};

/**
 * Stagger item wrapper
 */
export const StaggerItem: React.FC<{
    children: React.ReactNode;
    className?: string;
}> = ({ children, className }) => (
    <motion.div variants={staggerItem} className={className}>
        {children}
    </motion.div>
);

/**
 * Fade in wrapper
 */
export const FadeIn: React.FC<{
    children: React.ReactNode;
    className?: string;
    delay?: number;
}> = ({ children, className, delay = 0 }) => (
    <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay, ease: "easeOut" }}
        className={className}
    >
        {children}
    </motion.div>
);

/**
 * Animated presence wrapper for conditional rendering
 */
export const AnimatedPresence = AnimatePresence;

/**
 * Re-export motion for direct use
 */
export { motion };
