
import React, { useEffect, useRef } from 'react';

export const Confetti = ({ active, onComplete }: { active: boolean, onComplete: () => void }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles: any[] = [];
    const particleCount = 150;
    const colors = ['#a855f7', '#ec4899', '#3b82f6', '#22c55e', '#eab308'];

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: canvas.width / 2,
        y: canvas.height / 2,
        vx: (Math.random() - 0.5) * 20,
        vy: (Math.random() - 0.5) * 20 - 5,
        life: 100 + Math.random() * 50,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 8 + 4
      });
    }

    let animationId: number;
    
    const update = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      let activeParticles = 0;
      
      particles.forEach(p => {
        if (p.life > 0) {
          activeParticles++;
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.5; // Gravity
          p.life--;
          
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x, p.y, p.size, p.size);
        }
      });

      if (activeParticles > 0) {
        animationId = requestAnimationFrame(update);
      } else {
        onComplete();
      }
    };

    update();

    return () => cancelAnimationFrame(animationId);
  }, [active]);

  if (!active) return null;

  return (
    <canvas 
      ref={canvasRef} 
      className="fixed inset-0 pointer-events-none z-[60]"
    />
  );
};
