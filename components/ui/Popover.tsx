import React, { useState, useRef, useEffect, createContext, useContext } from 'react';

const cn = (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(' ');

interface PopoverContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const PopoverContext = createContext<PopoverContextType | undefined>(undefined);

export interface PopoverProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const Popover: React.FC<PopoverProps> = ({ children, open, onOpenChange }) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? (onOpenChange || (() => {})) : setInternalOpen;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, setIsOpen]);

  return (
    <PopoverContext.Provider value={{ open: !!isOpen, setOpen: setIsOpen }}>
      <div ref={ref} className="relative inline-block text-left">
        {children}
      </div>
    </PopoverContext.Provider>
  );
};

export const PopoverTrigger = ({ asChild, children, ...props }: any) => {
  const context = useContext(PopoverContext);
  if (!context) throw new Error("PopoverTrigger must be used within Popover");

  const handleClick = () => {
    context.setOpen(!context.open);
  };

  const child = React.Children.only(children) as React.ReactElement<any>;
  return React.cloneElement(child, {
    onClick: (e: React.MouseEvent) => {
      child.props.onClick?.(e);
      handleClick();
    },
    "data-state": context.open ? "open" : "closed",
    ...props
  });
};

export const PopoverContent = ({ className, align = "center", children, ...props }: React.HTMLAttributes<HTMLDivElement> & { align?: "start" | "center" | "end" }) => {
  const context = useContext(PopoverContext);
  if (!context) throw new Error("PopoverContent must be used within Popover");

  if (!context.open) return null;

  const alignments = {
    start: "left-0",
    center: "left-1/2 -translate-x-1/2",
    end: "right-0"
  };

  return (
    <div
      className={cn(
        "absolute z-50 mt-2 rounded-md border bg-white p-1 text-slate-950 shadow-md animate-in fade-in-0 zoom-in-95 w-max",
        alignments[align],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};