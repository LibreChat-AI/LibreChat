export type RenderProp<
  P = React.HTMLAttributes<any> & {
    ref?: React.Ref<any>;
  },
> = (props: P) => React.ReactNode;

export interface MenuItemProps {
  id?: string;
  label?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement | HTMLDivElement>) => void;
  icon?: React.ReactNode;
  kbd?: string;
  show?: boolean;
  disabled?: boolean;
  separate?: boolean;
  hideOnClick?: boolean;
  dialog?: React.ReactElement;
  ariaHasPopup?: React.AriaAttributes['aria-haspopup'];
  ariaControls?: string;
  ariaLabel?: string;
  ariaChecked?: boolean;
  ref?: React.Ref<any>;
  className?: string;
  render?:
    | RenderProp<React.HTMLAttributes<any> & { ref?: React.Ref<any> | undefined }>
    | React.ReactElement<any, string | React.JSXElementConstructor<any>>
    | undefined;
  subItems?: MenuItemProps[];
}
