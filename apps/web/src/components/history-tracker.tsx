'use client';

import { useEffect } from 'react';
import { installHistoryTracking } from '@/lib/history-guard';

/**
 * يُركّب تتبع موقع السجل مبكرًا (تأثيرات الأبناء تعمل قبل تأثير جذر Next)،
 * ليتمكن محرر النموذج من حماية التنقل بزري الرجوع والتقدم.
 */
export function HistoryTracker() {
  useEffect(() => {
    installHistoryTracking();
  }, []);
  return null;
}
