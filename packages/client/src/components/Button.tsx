import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { ClassProp } from 'class-variance-authority/types';
import { cva, type VariantProps } from 'class-variance-authority';
import { disabledFillClasses } from '~/utils/theme';
import { cn } from '~/utils';

type ButtonVariantOptions =
  | ({
      variant?:
        | 'default'
        | 'link'
        | 'submit'
        | 'outline'
        | 'outline-toggle'
        | 'choice'
        | 'subtle'
        | 'destructive'
        | 'secondary'
        | 'ghost'
        | 'media'
        | 'row-action'
        | 'row-action-reveal'
        | 'section-header'
        | 'section-action'
        | 'header-action'
        | 'inline-edit'
        | 'card'
        | null
        | undefined;
      size?:
        | 'default'
        | 'dense'
        | 'compact'
        | 'icon'
        | 'icon-sm'
        | 'icon-xs'
        | 'icon-theme'
        | 'xs'
        | 'sm'
        | 'lg'
        | 'theme'
        | 'row'
        | 'tile'
        | null
        | undefined;
      shape?: 'default' | 'theme' | 'round' | null | undefined;
    } & ClassProp)
  | undefined;

const buttonVariantRecipe = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-theme-control ring-offset-surface-primary transition-colors duration-theme-fast focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
    disabledFillClasses,
  ],
  {
    variants: {
      variant: {
        default:
          'bg-button-primary text-text-inverted hover:bg-button-primary-hover hover:active:bg-surface-inverted-pressed',
        destructive:
          'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover',
        outline:
          'text-text-primary border border-border-light bg-transparent hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary',
        /** An outlined filter whose pressed state stays visible between activations. */
        'outline-toggle':
          'text-text-primary border border-border-light bg-transparent transition-none hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary aria-pressed:border-border-heavy aria-pressed:bg-surface-active-alt aria-pressed:hover:bg-surface-active-alt',
        /**
         * A selectable answer inside a question card. `outline` is wrong here:
         * its `border-light` edge measures ~1.2:1 against the panel these sit
         * on, well under WCAG 1.4.11's 3:1 for a UI component boundary, so a
         * column of choices reads as flat text rather than as controls. Carries
         * its own fill so the answers are a different colour from the prompt,
         * and drops to `font-normal` so the question above stays the heading.
         */
        choice:
          'border border-border-xheavy bg-surface-tertiary font-normal text-text-primary hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary',
        subtle:
          'border border-border-light bg-transparent text-text-primary hover:bg-surface-secondary focus-visible:ring-focus-control focus-visible:ring-offset-0',
        secondary:
          'bg-surface-secondary text-text-primary hover:bg-surface-hover hover:active:bg-surface-pressed',
        ghost: 'hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary',
        /**
         * A control drawn over the user's own media (a lightbox toolbar, an image preview's close):
         * ghost-shaped, with the media ink and a tint of it on hover, so it stays legible on the
         * black media scrim whatever the page theme paints.
         */
        media: 'text-text-on-media hover:bg-text-on-media/10',
        /**
         * A compact action living inside a list row — a pinned row's unpin
         * badge, a conversation's overflow trigger, a table row's controls. The
         * rows stay `rounded-lg`; this sits one step inside them, so it
         * overrides the base radius rather than matching its host.
         */
        'row-action': 'rounded-md hover:bg-surface-hover-alt hover:text-text-primary',
        /** A row action revealed by hover or keyboard focus, and kept visible
         * while its dialog or menu is open. Touch users always see it. */
        'row-action-reveal':
          'shrink-0 rounded-md text-text-secondary transition-opacity hover:bg-surface-hover-alt hover:text-text-primary data-[open]:bg-surface-active data-[open]:text-text-primary data-[open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100',
        link: 'text-text-primary underline-offset-4 hover:underline',
        submit: 'bg-surface-submit text-text-on-status hover:bg-surface-submit-hover',
        /**
         * The toggle that heads a collapsible sidebar section, such as Chats,
         * Projects and Pinned. It stays a quiet label rather than a control:
         * no hover fill, because a heading that lights up competes with the
         * rows it heads. Its ring is inset because these sit flush against the
         * section body, and it carries its own metrics through the compound
         * below, since a section heading is sized by its text.
         */
        'section-header':
          'justify-start gap-1 rounded-lg px-1 py-2 text-xs font-medium text-text-secondary focus-visible:ring-inset focus-visible:ring-offset-0',
        /**
         * A quiet icon action sitting beside a section heading in the sidebar.
         * Unlike `row-action`, it recedes until hovered so the heading stays
         * the thing being read, and its ring sits inside the control because
         * these sit close enough that an offset one would cross a neighbour.
         * One radius step inside the heading row, like every other control that
         * sits on one.
         */
        'section-action':
          'rounded-md text-text-secondary hover:bg-surface-active-alt hover:text-text-primary focus-visible:ring-inset focus-visible:ring-offset-0',
        /**
         * A control floating on the presentation surface — the sidebar
         * toggle in the chat header and its mirror in the mobile drawer
         * header, so the pair reads as one persistent button across views.
         * The fill is opaque and not transparent: the chat header is a
         * gradient that fades to nothing while the conversation scrolls
         * underneath, so a see-through control has message text moving
         * through it, and every neighbour in that row — model selector, new
         * chat, overflow menu — already sits on `bg-presentation`.
         * `duration-0` makes the hover fill instant: these sit over a
         * scrolling gradient, where the shared color transition reads as
         * lag rather than polish.
         */
        'header-action':
          'rounded-xl border border-border-light bg-presentation text-text-primary duration-0 hover:bg-surface-active-alt hover:text-text-primary',
        /**
         * Text that turns into its own editor when activated, such as a workspace
         * title or description. It reads as the text it stands for, so the caller
         * sets the typography on the text it renders and this adds only the hover
         * fill and the focus ring that mark it as a control.
         */
        'inline-edit':
          'justify-start whitespace-normal text-left hover:bg-surface-hover focus-visible:ring-inset focus-visible:ring-offset-0',
        /**
         * A whole card or list row that is one click target, such as a project
         * tile or a chat row. It carries no fill of its own because the card
         * around it owns the surface; it adds the hover fill and an inset ring,
         * and left-aligns its content, which the caller lays out.
         */
        card: 'justify-start whitespace-normal rounded-2xl text-left font-normal hover:bg-surface-hover focus-visible:ring-inset focus-visible:ring-offset-0',
      },
      size: {
        default: 'h-theme-button px-4 py-2',
        /** Default-height actions with less horizontal padding, such as Copy link. */
        dense: 'h-theme-button px-3 py-2',
        /** Compact text controls that share a toolbar row with a compact dropdown. */
        compact: 'h-8 gap-1.5 px-2.5 py-2 text-xs',
        /**
         * A chip, the text counterpart of `icon-xs`: the reset beside a list that
         * matched nothing, and anything else that offers a way out without asking
         * to be the thing the eye lands on.
         */
        xs: 'h-7 rounded-md px-2.5 text-xs',
        sm: 'h-theme-button-sm rounded-lg px-3',
        lg: 'h-11 rounded-lg px-8',
        icon: 'size-10',
        'icon-sm': 'size-8 p-0',
        'icon-xs': 'size-7',
        /**
         * A square icon control on the theme's control height — the size of
         * every button in the composer's action row, for a control that has to
         * line up with them.
         */
        'icon-theme': 'size-theme-control p-0',
        theme: 'h-theme-control gap-theme-control-gap px-theme-control-x',
        /** The padding of a list row that is itself the click target. */
        row: 'h-auto gap-3 px-3.5 py-3',
        /** The padding of a tile that reserves a corner for an overflow menu. */
        tile: 'h-auto gap-0 p-4 pr-12',
      },
      shape: {
        default: 'rounded-lg',
        theme: 'rounded-theme-control',
        round: 'rounded-theme-control-round',
        unset: '',
      },
    },
    compoundVariants: [
      {
        variant: 'subtle',
        shape: 'unset',
        class: 'rounded-xl',
      },
      /* A section heading is sized by its own text, so it opts out of the
       * default size recipe that every other caller supplies explicitly.
       * Without this the default `h-10 px-4` is emitted after the variant and
       * wins the merge, giving a 40px control in a 32px header row. */
      {
        variant: 'section-header',
        size: 'default',
        class: 'h-auto px-1 py-2',
      },
      /* Sized by the text it stands for, like `section-header`, so the default
       * size recipe must not pad it away from the content it lines up with. */
      {
        variant: 'inline-edit',
        size: 'default',
        class: 'h-auto px-0 py-1',
      },
      /* `size: 'sm'` brings its own `rounded-lg`, emitted after the variant
       * and so winning the merge. A text-bearing header control keeps the
       * row's `rounded-xl` corner, matching the icon-sized ones beside it.
       * Gated on `shape: 'unset'` like `subtle` above: a compound is emitted
       * after the shape recipe, so an ungated one would silently outrank a
       * caller that asked for `shape="theme"` or `shape="round"`. */
      {
        variant: 'header-action',
        size: 'sm',
        shape: 'unset',
        class: 'rounded-xl',
      },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
      shape: 'unset',
    },
  },
);

const buttonVariants: (props?: ButtonVariantOptions) => string = (props) =>
  buttonVariantRecipe(
    props == null ? props : { ...props, shape: props.shape == null ? 'unset' : props.shape },
  );

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button: React.ForwardRefExoticComponent<
  ButtonProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        type={asChild ? undefined : type}
        className={cn(buttonVariants({ variant, size, shape, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
