/** 検索の文字に当たった部分を強調する（当たらなければ、そのまま）。needle は小文字にした検索の文字 */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  const start = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
  if (start < 0) return <>{text}</>;
  const end = start + needle.length;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-yellow-200 text-inherit">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}
