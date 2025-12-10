import React from 'react';

const cn = (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(' ');

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "destructive";
}

export const Alert: React.FC<AlertProps> = ({ variant = "default", className, children, ...props }) => (
  <div
    role="alert"
    className={cn(
      "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
      variant === "destructive" &&
        "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const AlertTitle = ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h5 className={cn("mb-1 font-medium leading-none tracking-tight", className)} {...props}>
    {children}
  </h5>
);

export const AlertDescription = ({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("text-sm [&_p]:leading-relaxed", className)} {...props}>
    {children}
  </div>
);