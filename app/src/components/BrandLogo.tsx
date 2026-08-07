import corporateLogo from "@/assets/brand/sanpo-corporate-master-approved-v1.svg";
import explanatoryLogo from "@/assets/brand/sanpo-explanatory-lockup-approved-v1.svg";

export function BrandLogo({
  explanatory = false,
  className,
}: {
  explanatory?: boolean;
  className?: string;
}) {
  return (
    <img
      src={explanatory ? explanatoryLogo : corporateLogo}
      alt="Sanpo"
      width="1254"
      height="1254"
      className={`brand-logo${className ? ` ${className}` : ""}`}
    />
  );
}
