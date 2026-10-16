import { useLayoutEffect, useState } from 'react';

type Theme = 'dark' | 'light';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [themeError, setThemeError] = useState('');
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    try {
      // Appearance is independent of model settings and never contains form drafts.
      localStorage.setItem('tappilot.theme', next);
      setThemeError('');
    } catch { setThemeError('主题已切换，但未能保存偏好。'); }
    setTheme(next);
  };
  return { theme, themeError, toggleTheme };
}
