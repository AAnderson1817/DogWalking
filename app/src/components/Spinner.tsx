export function Spinner({
  label = "Loading",
  decorative = false,
}: {
  label?: string;
  decorative?: boolean;
}) {
  return (
    <span
      className="spinner"
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
    />
  );
}
