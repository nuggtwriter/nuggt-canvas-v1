import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export const cn = (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(' ');

interface AccordionProps extends React.HTMLAttributes<HTMLDivElement> {
  type?: string;
  collapsible?: boolean;
}

export const Accordion: React.FC<AccordionProps> = ({ className, children, type, collapsible, ...props }) => {
  const [openItem, setOpenItem] = useState<string>("");

  const handleValueChange = (value: string) => {
    setOpenItem(prev => (prev === value ? "" : value));
  };

  return (
    <div className={cn("w-full space-y-1", className)} {...props}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          const item = child as React.ReactElement<any>;
          return React.cloneElement(item, { 
            isOpen: openItem === item.props.value,
            onClick: () => handleValueChange(item.props.value)
          });
        }
        return child;
      })}
    </div>
  );
};

interface AccordionTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isOpen?: boolean;
}

export const AccordionTrigger: React.FC<AccordionTriggerProps> = ({ className, children, isOpen, onClick, ...props }) => (
  <div className="flex">
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-between py-4 font-medium transition-all hover:underline [&[data-state=open]>svg]:rotate-180",
        className
      )}
      data-state={isOpen ? "open" : "closed"}
      {...props}
    >
      {children}
      <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
    </button>
  </div>
);

interface AccordionContentProps extends React.HTMLAttributes<HTMLDivElement> {
  isOpen?: boolean;
}

export const AccordionContent: React.FC<AccordionContentProps> = ({ className, children, isOpen, ...props }) => (
  <div
    className={cn(
      "overflow-hidden text-sm transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
      className
    )}
    data-state={isOpen ? "open" : "closed"}
    hidden={!isOpen}
    {...props}
  >
    <div className="pb-4 pt-0">{children}</div>
  </div>
);

interface AccordionItemProps extends React.HTMLAttributes<HTMLDivElement> {
  isOpen?: boolean;
  value?: string;
}

export const AccordionItem: React.FC<AccordionItemProps> = ({ className, children, isOpen, onClick, value, ...props }) => (
  <div className={cn("border-b", className)} {...props}>
    {React.Children.map(children, (child) => {
      if (React.isValidElement(child)) {
        return React.cloneElement(child as React.ReactElement<any>, { 
          isOpen,
          onClick: child.type === AccordionTrigger ? onClick : undefined
        });
      }
      return child;
    })}
  </div>
);