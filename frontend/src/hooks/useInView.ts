import { useEffect, useRef, useState } from "react";

/**
 * 要素が画面（スクロール領域）に見えているかを返すフック。
 * センサー棚のように行が多いとき、見えている行だけデータを取るために使う。
 * IntersectionObserver が無い環境（テストなど）では、常に見えているものとして扱う。
 */
export function useInView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setInView(entry.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, inView };
}
