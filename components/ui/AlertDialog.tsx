
import React, { useState } from 'react';
import { Button } from './Button';
import { executeAction } from '../../utils/registry';

export const PreviewAlertDialog = ({ 
  trigger, 
  title, 
  description, 
  cancelText, 
  actionText,
  actionPrompt 
}: { 
  trigger: string; 
  title: string; 
  description: string; 
  cancelText?: string; 
  actionText?: string;
  actionPrompt?: string;
}) => {
  const [open, setOpen] = useState(false);

  const handleAction = () => {
    if (actionPrompt) {
      executeAction(actionPrompt);
    }
    setOpen(false);
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {trigger}
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div 
            className="fixed inset-0 bg-black/80 animate-in fade-in-0"
            onClick={() => setOpen(false)}
          />
          <div className="fixed left-[50%] top-[50%] z-50 grid w-[90%] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-white p-6 shadow-lg duration-200 sm:rounded-lg">
            <div className="flex flex-col space-y-2 text-center sm:text-left">
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="text-sm text-slate-500">{description}</p>
            </div>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setOpen(false)}>
                {cancelText || "Cancel"}
              </Button>
              <Button onClick={handleAction}>
                {actionText || "Continue"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
