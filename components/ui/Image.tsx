import * as React from "react"

const cn = (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(' ');

export interface ImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string
  alt: string
  caption?: string
  rounded?: "none" | "sm" | "md" | "lg" | "xl" | "full"
  objectFit?: "cover" | "contain" | "fill" | "none"
}

const ImageNuggt = React.forwardRef<HTMLDivElement, ImageProps>(
  ({ src, alt, caption, rounded = "lg", objectFit = "cover", className, ...props }, ref) => {
    const roundedClasses = {
      none: "",
      sm: "rounded-sm",
      md: "rounded-md",
      lg: "rounded-lg",
      xl: "rounded-xl",
      full: "rounded-full"
    }
    
    const objectFitClasses = {
      cover: "object-cover",
      contain: "object-contain",
      fill: "object-fill",
      none: "object-none"
    }
    
    return (
      <figure ref={ref} className={cn("w-full", className)}>
        <div className={cn(
          "w-full overflow-hidden bg-slate-100",
          roundedClasses[rounded]
        )}>
          <img
            src={src}
            alt={alt}
            className={cn(
              "w-full h-auto",
              objectFitClasses[objectFit]
            )}
            loading="lazy"
            {...props}
          />
        </div>
        {caption && (
          <figcaption className="mt-2 text-center text-sm text-slate-500 italic">
            {caption}
          </figcaption>
        )}
      </figure>
    )
  }
)
ImageNuggt.displayName = "ImageNuggt"

export { ImageNuggt }

