
import React, { useEffect, useState } from 'react';
import { X, CheckCircle, AlertCircle } from 'lucide-react';

export interface ToastMessage {
  id: string;
  message: string;
  type: string;
}

export const ToastContainer = ({ toasts, removeToast }: { toasts: ToastMessage[], removeToast: (id: string) => void }) => {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div 
          key={toast.id}
          className="flex items-center gap-3 bg-white border shadow-lg rounded-lg p-4 min-w-[300px] animate-in slide-in-from-right-full duration-300"
        >
          {toast.type === 'error' ? (
            <AlertCircle className="w-5 h-5 text-red-500" />
          ) : (
            <CheckCircle className="w-5 h-5 text-green-500" />
          )}
          <p className="text-sm font-medium text-slate-800 flex-1">{toast.message}</p>
          <button onClick={() => removeToast(toast.id)} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
};
