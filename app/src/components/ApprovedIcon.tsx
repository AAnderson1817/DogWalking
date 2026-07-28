import type { CSSProperties } from "react";
import { APPROVED_ICON_URLS, type ApprovedIconName } from "./approved-icons";

export function ApprovedIcon({
  name,
  size = 24,
  className,
}: {
  name: ApprovedIconName;
  size?: number;
  className?: string;
}) {
  const maskImage = `url("${APPROVED_ICON_URLS[name]}")`;
  const style: CSSProperties = {
    width: size,
    height: size,
    WebkitMaskImage: maskImage,
    maskImage,
  };

  return (
    <span
      className={`approved-icon${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    />
  );
}
