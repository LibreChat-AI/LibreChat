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
        | 'link-accent'
        | 'hyperlink'
        | 'submit'
        | 'outline'
        | 'outline-toggle'
        | 'floating'
        | 'choice'
        | 'subtle'
        | 'destructive'
        | 'destructive-soft'
        | 'secondary'
        | 'ghost'
        | 'quiet'
        | 'message-action'
        | 'inline-link'
        | 'carousel-nav'
        | 'toolbar'
        | 'nav'
        | 'media'
        | 'row-action'
        | 'row-action-reveal'
        | 'section-header'
        | 'section-action'
        | 'header-action'
        | 'inline-edit'
        | 'card'
        | 'disclosure'
        | 'option'
        | 'text-action'
        | 'row-content'
        | 'chip-toggle'
        | 'pill-toggle'
        | 'composer-pill'
        | 'composer-trigger'
        | 'hit-area'
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
        | 'auth'
        | 'auth-action'
        | 'wide'
        | 'snug'
        | 'bare'
        | 'theme'
        | 'row'
        | 'tile'
        | null
        | undefined;
      shape?: 'default' | 'soft' | 'auth-action' | 'theme' | 'round' | null | undefined;
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
        /**
         * A destructive action offered inline, such as a row's delete or a revoke beside its
         * label. A theme whose `destructiveStyle` is `soft` tints it; the confirming button of a
         * destructive dialog stays `destructive`, the strongest action on screen.
         */
        'destructive-soft':
          'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover theme-destructive-soft:bg-surface-destructive/10 theme-destructive-soft:text-text-destructive theme-destructive-soft:hover:bg-surface-destructive/14 theme-destructive-soft:hover:active:bg-surface-destructive/17',
        outline:
          'text-text-primary border border-border-light bg-transparent hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary',
        /**
         * A control floating over scrolling content, such as the scroll-to-bottom chip. A theme that
         * draws no chrome outline gives it an opaque fill and a lift instead, so it never reads as a
         * bare glyph over the thread.
         */
        floating:
          'border border-border-chrome bg-surface-chat/90 text-text-primary hover:bg-surface-hover hover:active:bg-surface-pressed theme-chrome-quiet:bg-surface-chat theme-chrome-quiet:shadow-md theme-chrome-quiet:hover:bg-surface-hover theme-chrome-quiet:hover:active:bg-surface-pressed',
        /** An outlined filter whose pressed state stays visible between activations. */
        'outline-toggle':
          'text-text-primary border border-border-control bg-transparent transition-none hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary aria-pressed:border-border-heavy aria-pressed:bg-surface-active-alt aria-pressed:hover:bg-surface-active-alt',
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
        /** A ghost that rests in the secondary ink and rises to the primary one under the pointer,
         *  for a control that should not compete with the content it sits beside. */
        quiet:
          'text-text-secondary hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary',
        /** An icon action under a message: a small padded square that rests in the alt secondary ink. */
        'message-action':
          'size-auto rounded-lg p-1.5 text-text-secondary-alt hover:bg-surface-hover hover:active:bg-surface-pressed hover:text-text-primary',
        /** A text action that reads as a link in a list or footer: no fill at rest or under the pointer,
         *  and a ring flush against the control. */
        'inline-link':
          'h-auto justify-start gap-2 rounded-none p-0 font-normal text-text-secondary hover:bg-transparent hover:text-text-primary focus-visible:ring-offset-0',
        /** A previous or next arrow floating over a carousel's content, on the fixed surface. */
        'carousel-nav':
          'rounded-xl bg-surface-fixed p-2 text-text-fixed shadow-lg hover:bg-surface-fixed-hover hover:shadow-xl',
        /** A compact text action in a toolbar, quiet until hovered. */
        toolbar:
          'rounded-sm bg-transparent px-2 py-1 text-xs font-normal text-text-secondary hover:bg-surface-hover',
        /** A destination in a navigation rail. The fills are the theme's navigation roles, and the
         *  current destination is marked with `aria-pressed`, so a caller sets no class for it. */
        nav: 'text-text-secondary hover:bg-surface-nav-hover hover:text-text-primary hover:active:bg-surface-pressed aria-pressed:bg-surface-nav-selected aria-pressed:text-text-primary aria-pressed:hover:bg-surface-nav-selected',
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
         * while its dialog or menu is open. Any touchscreen, including the one on
         * a 2-in-1 whose trackpad reports hover, always sees it. */
        'row-action-reveal':
          'shrink-0 rounded-md text-text-secondary transition-opacity hover:bg-surface-hover-alt hover:text-text-primary data-[open]:bg-surface-active data-[open]:text-text-primary data-[open]:opacity-100 no-touch:opacity-0 no-touch:focus-visible:opacity-100 no-touch:group-focus-within:opacity-100 no-touch:group-hover:opacity-100',
        link: 'text-text-primary underline-offset-4 hover:underline',
        /** A link-weight action in the accent color, such as the alternate way to confirm a sign-in. */
        'link-accent':
          'text-accent-primary underline-offset-4 hover:text-accent-primary-hover hover:underline',
        /** An action set inside a sentence in the hyperlink color, sized by its own text. */
        hyperlink: 'text-link underline-offset-4 hover:underline',
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
          'rounded-xl border border-border-chrome bg-presentation text-text-primary duration-0 hover:bg-surface-active-alt hover:text-text-primary',
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
        /**
         * The header row that folds a tool call's details open: it reads as the
         * line of text it labels, so it takes no fill under the pointer or while
         * pressed, and a header with nothing to open keeps full opacity. Its ring
         * is inset because the row sits flush against the panel it opens.
         */
        disclosure:
          'w-full justify-start focus-visible:ring-focus-subtle focus-visible:ring-offset-0 disabled:opacity-100',
        /**
         * A full-width answer row in an option list, such as the choices of an
         * `ask_user_question`. The fill follows the pointer instantly rather than
         * easing, so moving down a list reads as a cursor, while locking and
         * unlocking fades slowly: only opacity transitions while enabled, and a
         * disabled row, which cannot be hovered, eases its theme colors too.
         * The duration rides on `enabled:`/`disabled:` so it outranks the base
         * `duration-theme-fast` by specificity, which tailwind-merge cannot
         * resolve between the two. Reduced motion drops both fades.
         * `data-selected` marks the highlighted or chosen row.
         */
        option:
          'w-full select-none justify-start gap-2.5 whitespace-normal text-left font-normal text-text-primary transition-opacity enabled:duration-500 disabled:duration-500 disabled:transition-all motion-reduce:transition-none motion-reduce:disabled:transition-none hover:bg-surface-hover hover:active:bg-surface-pressed data-[selected=true]:bg-surface-active data-[selected=true]:hover:bg-surface-active',
        card: 'justify-start whitespace-normal rounded-2xl text-left font-normal hover:bg-surface-hover focus-visible:ring-inset focus-visible:ring-offset-0',
        /** A small text action in the secondary ink beside a status line, such as a failed
         *  steer's Retry or a pending one's Cancel; it rises to the primary ink under the pointer. */
        'text-action':
          'rounded text-xs text-text-secondary hover:text-text-primary focus-visible:ring-offset-0',
        /** The content of a list row whose row owns the highlight, such as a composer palette
         *  entry: it lays the row out and takes the pointer, and leaves fill and ink to the row. */
        'row-content':
          'flex cursor-pointer justify-start gap-2.5 px-2 text-left font-normal transition-none',
        /** An outlined chip that toggles a mode, its pressed state marked with `aria-pressed`. */
        'chip-toggle':
          'min-h-theme-target shrink-0 rounded-full border border-border-medium text-xs font-normal text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-offset-0 aria-pressed:border-transparent aria-pressed:bg-surface-active-alt aria-pressed:text-text-primary aria-pressed:hover:bg-surface-active-alt',
        /** A borderless pill that toggles a mode, lit in the accent while `aria-pressed`. */
        'pill-toggle':
          'rounded-full text-xs font-normal text-text-secondary hover:bg-surface-hover hover:text-text-primary aria-pressed:bg-accent-primary/15 aria-pressed:text-accent-primary aria-pressed:hover:bg-accent-primary/15 aria-pressed:hover:text-accent-primary',
        /** A composer pill that opens a popover with its value, such as Thinking: primary ink,
         *  and kept lit while the popover it controls is expanded. */
        'composer-pill':
          'gap-1 rounded-theme-control-round font-normal text-text-primary hover:bg-surface-hover focus-visible:ring-offset-0 aria-expanded:bg-surface-hover',
        /** A composer control that opens a popover from an icon, such as the reasoning menu: it
         *  rests in the secondary ink and takes the primary one while hovered or expanded. */
        'composer-trigger':
          'gap-1.5 rounded-xl text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-offset-0 aria-expanded:bg-surface-hover aria-expanded:text-text-primary',
        /** An invisible target laid over a custom-drawn control, such as a stop on a slider rail:
         *  it draws only its focus ring, inside its own box. */
        'hit-area':
          'rounded-full bg-transparent focus-visible:ring-inset focus-visible:ring-offset-0',
      },
      size: {
        default: 'h-theme-button px-theme-button-x py-2',
        /** Default-height actions with less horizontal padding, such as Copy link. */
        dense: 'h-theme-button px-3 py-2',
        /** Compact text controls that share a toolbar row with a compact dropdown. */
        compact: 'h-theme-button-compact gap-1.5 px-2.5 py-2 text-xs',
        /**
         * A chip, the text counterpart of `icon-xs`: the reset beside a list that
         * matched nothing, and anything else that offers a way out without asking
         * to be the thing the eye lands on.
         */
        xs: 'h-theme-button-xs rounded-md px-2.5 text-xs',
        sm: 'h-theme-button-sm rounded-lg px-3',
        lg: 'h-theme-button-lg rounded-lg px-8',
        /** The height of a sign-in form's submit button, the `authButtonHeight` role. */
        auth: 'h-theme-auth-button px-theme-button-x',
        /** The other actions of the sign-in flow, the `authActionHeight` role. */
        'auth-action': 'h-theme-auth-action px-theme-button-x',
        /** Default height with the generous pad of a dialog's confirming action. */
        wide: 'h-theme-button px-8',
        /** Default height with a snug pad, for a text action that sits close to its neighbors. */
        snug: 'h-theme-button p-1',
        /** Sized by its own text with no pad, for an action set inside a sentence. */
        bare: 'h-auto p-0',
        icon: 'size-theme-button',
        'icon-sm': 'size-theme-icon-button-sm p-0',
        'icon-xs': 'size-theme-button-xs',
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
        /** The corner of a sign-in form's controls, the `authControlRadius` role. */
        soft: 'rounded-theme-auth-control',
        /** The corner of the sign-in flow's other actions, the `authActionRadius` role. */
        'auth-action': 'rounded-theme-auth-action',
        theme: 'rounded-theme-control',
        round: 'rounded-theme-control-round',
        unset: '',
      },
    },
    compoundVariants: [
      /* An outlined icon button is chrome: a theme that draws no chrome outline leaves it ghost-shaped. */
      {
        variant: ['outline', 'subtle'],
        size: ['icon', 'icon-sm', 'icon-xs', 'icon-theme'],
        class: 'border-border-chrome',
      },
      {
        variant: 'subtle',
        shape: 'unset',
        class: 'rounded-xl',
      },
      /* A section heading is sized by its own text, so it opts out of the
       * default size recipe that every other caller supplies explicitly.
       * Without this the default size's height and padding are emitted after the variant and
       * win the merge, giving a 40px control in a 32px header row. */
      {
        variant: 'section-header',
        size: 'default',
        class: 'h-auto px-1 py-2',
      },
      /* These carry their own box, which the default size's height and padding would otherwise win. */
      { variant: 'message-action', size: 'default', class: 'size-auto p-1.5' },
      { variant: 'inline-link', size: 'default', class: 'h-auto p-0' },
      { variant: 'carousel-nav', size: 'default', class: 'h-auto p-2' },
      { variant: 'toolbar', size: 'default', class: 'h-auto px-2 py-1' },
      /* Sized by its own label, so a long option wraps instead of clipping. */
      {
        variant: 'option',
        size: 'default',
        class: 'h-auto px-2.5 py-2',
      },
      /* Sized and shaped by the row it heads, like `section-header`. */
      {
        variant: 'disclosure',
        size: 'default',
        class: 'h-auto rounded-none p-0',
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
      /* These carry their own box, which the default size's height and padding would otherwise win. */
      { variant: 'text-action', size: 'default', class: 'h-auto p-0' },
      { variant: 'row-content', size: 'default', class: 'h-auto px-2 py-0' },
      { variant: 'chip-toggle', size: 'default', class: 'h-auto px-2 py-0.5' },
      { variant: 'pill-toggle', size: 'default', class: 'h-auto px-2 py-0.5' },
      { variant: 'composer-pill', size: 'default', class: 'h-theme-button-compact px-2.5 py-0' },
      { variant: 'composer-trigger', size: 'default', class: 'h-theme-button-compact px-2 py-0' },
      { variant: 'hit-area', size: 'default', class: 'h-auto p-0' },
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
