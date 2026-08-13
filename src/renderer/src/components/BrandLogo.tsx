import logoUrl from '../assets/luckytag-reborn-icon.png'

interface BrandLogoProps {
  className?: string
}

export function BrandLogo({ className = '' }: BrandLogoProps): React.JSX.Element {
  return (
    <img
      alt=""
      className={`brand-logo${className ? ` ${className}` : ''}`}
      draggable={false}
      src={logoUrl}
    />
  )
}
