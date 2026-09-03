import { useCallback, useEffect, useState } from 'react';
import type { OperationFeedback } from '../model';



export function useFeedback() {
  const [feedback, setFeedback] = useState<OperationFeedback>();

  const announce = useCallback((message: string, kind: OperationFeedback['kind'] = 'success'): void => {
    setFeedback({ message, kind });
  }, []);

  useEffect(() => {
    if (!feedback) return undefined;
    const timer = window.setTimeout(() => setFeedback(undefined), feedback.kind === 'error' ? 5200 : 3200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  return { feedback, announce };
}
