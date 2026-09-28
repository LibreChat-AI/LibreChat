import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { ClassProp } from 'class-variance-authority/types';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '~/utils';

type ButtonVariantOptions =
  | ({
      variant?:
        | 'default'
        | 'link'
        | 'submit'
        | 'outline'
        | 'choice'
        | 'subtle'
        | 'destructive'
        | 'secondary'
        | 'ghost'
        | 'row-action'
        | 'section-header'
        | 'section-action'
        | 'header-action'
        | null
        | undefined;
      size?:
        | 'default'
        | 'icon'
        | 'icon-sm'
        | 'icon-xs'
        | 'icon-theme'
        | 'sm'
        | 'lg'
        | 'theme'
        | null
        | undefined;
      shape?: 'default' | 'theme' | 'round' | null | undefined;
    } & ClassProp)
  | undefined;

const buttonVariantRecipe = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-surface-primary transition-colors duration-theme-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-surface-inverted text-text-inverted hover:bg-surface-inverted-hover',
        destructive:
          'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover',
        outline:
          'text-text-primary border border-border-light bg-transparent hover:bg-surface-hover hover:text-text-primary',
        /**
         * A selectable answer inside a question card. `outline` is wrong here:
         * its `border-light` edge measures ~1.2:1 against the panel these sit
         * on, well under WCAG 1.4.11's 3:1 for a UI component boundary, so a
         * column of choices reads as flat text rather than as controls. Carries
         * its own fill so the answers are a different colour from the prompt,
         * and drops to `font-normal` so the question above stays the heading.
         */
        choice:
          'border border-border-xheavy bg-surface-tertiary font-normal text-text-primary hover:bg-surface-hover hover:text-text-primary',
        subtle:
          'border border-border-light bg-transparent text-text-primary hover:bg-surface-secondary focus-visible:ring-text-primary focus-visible:ring-offset-0',
        secondary: 'bg-surface-secondary text-text-primary hover:bg-surface-hover',
        ghost: 'hover:bg-surface-hover hover:text-text-primary',
        /**
         * A compact action living inside a list row — a pinned row's unpin
         * badge, a conversation's overflow trigger, a table row's controls. The
         * rows stay `rounded-lg`; this sits one step inside them, so it
         * overrides the base radius rather than matching its host.
         */
        'row-action': 'rounded-md hover:bg-surface-hover-alt hover:text-text-primary',
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
          'justify-start gap-1 rounded-lg px-1 py-2 text-xs font-bold text-text-secondary focus-visible:ring-inset focus-visible:ring-offset-0',
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
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-lg px-3',
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
        theme: 'h-theme-control gap-theme-compact px-theme-normal',
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
