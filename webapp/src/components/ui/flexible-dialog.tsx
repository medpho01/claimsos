"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { DialogOverlay, DialogPortal } from "./dialog"

/**
 * FlexibleDialogContent
 * 
 * A variant of DialogContent that avoids using CSS transforms for centering.
 * Instead, it uses a flex container overlay.
 * 
 * WHY: CSS transforms create a new containing block for 'fixed' positioned descendants.
 * This means 'fixed' children (like our UploadQueuePanel) would be positioned relative 
 * to the dialog card, not the viewport.
 * 
 * By using flexbox centering on a wrapper, the Content element itself remains 
 * free of transforms, allowing its children to successfully use 'fixed' positioning 
 * relative to the viewport.
 */

const FlexibleDialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
        overlayClassName?: string
    }
>(({ className, children, overlayClassName, ...props }, ref) => (
    <DialogPortal>
        <DialogOverlay className={overlayClassName} />

        {/* 
      Wrapper to handle centering logic without interaction blocking.
      pointer-events-none ensures clicks passed through to the overlay (for closing) 
      or are ignored in empty space.
    */}
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <DialogPrimitive.Content
                ref={ref}
                className={cn(
                    // Base styles mimicking the original DialogContent but without positioning/transforms
                    "relative z-50 grid w-full max-w-lg gap-4 border bg-background p-6 shadow-lg duration-200",
                    // Animations
                    "data-[state=open]:animate-in data-[state=closed]:animate-out",
                    "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                    // Re-enable pointer events for the actual content
                    "pointer-events-auto",
                    "sm:rounded-lg",
                    className
                )}
                {...props}
            >
                {children}
                <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
        </div>
    </DialogPortal>
))
FlexibleDialogContent.displayName = "FlexibleDialogContent"

export { FlexibleDialogContent }
