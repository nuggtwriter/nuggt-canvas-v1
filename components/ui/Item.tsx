import * as React from "react"

const cn = (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(' ');

// Item Group - container for grouping related items
const ItemGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    variant?: "default" | "outline" | "muted"
    size?: "default" | "sm"
    separated?: boolean
  }
>(({ className, variant = "default", size = "default", separated = false, children, ...props }, ref) => {
  const variantClasses = {
    default: "bg-white border border-slate-200 shadow-sm",
    outline: "bg-transparent border-2 border-slate-300",
    muted: "bg-slate-50/80 border border-slate-200/60"
  }
  
  const sizeClasses = {
    default: "p-5",
    sm: "p-3"
  }
  
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-xl",
        variantClasses[variant],
        sizeClasses[size],
        separated && "divide-y divide-slate-200",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
})
ItemGroup.displayName = "ItemGroup"

// Item Header - for title and description
const ItemHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("mb-4", className)}
    {...props}
  />
))
ItemHeader.displayName = "ItemHeader"

// Item Title
const ItemTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn("text-lg font-semibold text-slate-900 leading-tight", className)}
    {...props}
  />
))
ItemTitle.displayName = "ItemTitle"

// Item Description
const ItemDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-slate-500 mt-1", className)}
    {...props}
  />
))
ItemDescription.displayName = "ItemDescription"

// Item Content - wraps the nested layout content
const ItemContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("space-y-4", className)}
    {...props}
  />
))
ItemContent.displayName = "ItemContent"

// Item Separator
const ItemSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("h-px bg-slate-200 my-4", className)}
    {...props}
  />
))
ItemSeparator.displayName = "ItemSeparator"

// Individual Item - for list-like content within a group
const Item = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    variant?: "default" | "outline" | "muted"
    size?: "default" | "sm"
  }
>(({ className, variant = "default", size = "default", ...props }, ref) => {
  const variantClasses = {
    default: "",
    outline: "border border-slate-200 rounded-lg",
    muted: "bg-slate-50 rounded-lg"
  }
  
  const sizeClasses = {
    default: "p-3",
    sm: "p-2"
  }
  
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-start gap-3",
        variantClasses[variant],
        variant !== "default" && sizeClasses[size],
        className
      )}
      {...props}
    />
  )
})
Item.displayName = "Item"

// Item Media - for icons, images, avatars
const ItemMedia = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    variant?: "default" | "icon" | "image"
  }
>(({ className, variant = "default", ...props }, ref) => {
  const variantClasses = {
    default: "w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600",
    icon: "w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600",
    image: "w-12 h-12 rounded-lg overflow-hidden"
  }
  
  return (
    <div
      ref={ref}
      className={cn(variantClasses[variant], "flex-shrink-0", className)}
      {...props}
    />
  )
})
ItemMedia.displayName = "ItemMedia"

// Item Actions
const ItemActions = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center gap-2 ml-auto", className)}
    {...props}
  />
))
ItemActions.displayName = "ItemActions"

// Item Footer
const ItemFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("mt-4 pt-4 border-t border-slate-200", className)}
    {...props}
  />
))
ItemFooter.displayName = "ItemFooter"

export {
  ItemGroup,
  ItemHeader,
  ItemTitle,
  ItemDescription,
  ItemContent,
  ItemSeparator,
  Item,
  ItemMedia,
  ItemActions,
  ItemFooter
}

