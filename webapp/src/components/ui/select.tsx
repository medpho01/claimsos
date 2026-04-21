"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  onValueChange?: (value: string) => void
}

// Create context to pass value and onValueChange from Select to SelectTrigger
interface SelectContextType {
  value?: string
  onValueChange?: (value: string) => void
  selectContentChildren?: React.ReactNode
}

const SelectContext = React.createContext<SelectContextType | undefined>(undefined)

const useSelectContext = () => {
  const context = React.useContext(SelectContext)
  return context || {}
}

// Select is a container component that provides context
const Select = React.forwardRef<HTMLDivElement, SelectProps>(
  ({ children, value, onValueChange, ...props }, ref) => {
    // Convert value to string for context
    const stringValue = typeof value === 'string' ? value : undefined

    // Filter out select-specific attributes that shouldn't be on a div
    const { autoComplete, disabled, form, multiple, name, required, size, ...divProps } = props as any

    // Extract SelectContent's children to pass to SelectTrigger
    let selectContentChildren: React.ReactNode = null
    const processedChildren = React.Children.map(children, (child) => {
      if (React.isValidElement(child) && (child.type as any).displayName === 'SelectContent') {
        selectContentChildren = (child.props as any).children
        return null // Don't render SelectContent itself
      }
      return child
    })

    return (
      <SelectContext.Provider value={{ value: stringValue, onValueChange, selectContentChildren }}>
        <div ref={ref} {...divProps}>
          {processedChildren}
        </div>
      </SelectContext.Provider>
    )
  }
)
Select.displayName = "Select"

// SelectTrigger is where the actual select element is rendered
const SelectTrigger = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, onChange, children, ...props }, ref) => {
    const context = useSelectContext()
    const value = context.value ?? ""
    const handleValueChange = context.onValueChange
    const selectOptions = context.selectContentChildren

    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      handleValueChange?.(e.target.value)
      onChange?.(e)
    }

    return (
      <div className="relative w-full">
        <select
          ref={ref}
          className={cn(
            "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 appearance-none cursor-pointer",
            className
          )}
          onChange={handleChange}
          value={value}
          {...props}
        >
          {selectOptions}
        </select>
        <ChevronDown className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50 pointer-events-none" />
      </div>
    )
  }
)
SelectTrigger.displayName = "SelectTrigger"

interface SelectValueProps extends React.HTMLAttributes<HTMLDivElement> {
  placeholder?: string
}

const SelectValue = React.forwardRef<
  HTMLDivElement,
  SelectValueProps
>(({ className, placeholder, ...props }, ref) => (
  // SelectValue doesn't render anything for native select
  // The native select element displays the selected value automatically
  null
))
SelectValue.displayName = "SelectValue"

const SelectContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  // SelectContent doesn't render anything for native select
  // It's just a wrapper component for API compatibility
  <>{props.children}</>
))
SelectContent.displayName = "SelectContent"

const SelectItem = React.forwardRef<
  HTMLOptionElement,
  React.OptionHTMLAttributes<HTMLOptionElement>
>(({ className, ...props }, ref) => (
  <option ref={ref} className={cn("py-1.5 pl-2 pr-8 text-sm", className)} {...props} />
))
SelectItem.displayName = "SelectItem"

const SelectGroup = React.forwardRef<
  HTMLOptGroupElement,
  React.OptgroupHTMLAttributes<HTMLOptGroupElement>
>(({ className, ...props }, ref) => (
  <optgroup ref={ref} className={cn("", className)} {...props} />
))
SelectGroup.displayName = "SelectGroup"

const SelectSeparator = React.forwardRef<
  HTMLHRElement,
  React.HTMLAttributes<HTMLHRElement>
>(({ className, ...props }, ref) => (
  <hr ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
))
SelectSeparator.displayName = "SelectSeparator"

const SelectScrollUpButton = SelectTrigger
const SelectScrollDownButton = SelectTrigger

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
}
