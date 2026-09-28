import {
  forwardRef,
  ForwardRefExoticComponent,
  isValidElement,
  ReactNode,
  Ref,
  RefAttributes,
} from 'react';
import {
  OGDialogTitle,
  OGDialogClose,
  OGDialogFooter,
  OGDialogHeader,
  OGDialogContent,
  OGDialogDescription,
} from './OriginalDialog';
import { useLocalize } from '~/hooks';
import { Button } from './Button';
import { Spinner } from '~/svgs';
import { cn } from '~/utils/';

type SelectionProps = {
  selectHandler?: () => void;
  selectClasses?: string;
  selectText?: string | ReactNode;
  isLoading?: boolean;
};

/**
 * Type guard to check if selection is a legacy SelectionProps object
 */
function isSelectionProps(selection: unknown): selection is SelectionProps {
  return (
    typeof selection === 'object' &&
    selection !== null &&
    !isValidElement(selection) &&
    ('selectHandler' in selection ||
      'selectClasses' in selection ||
      'selectText' in selection ||
      'isLoading' in selection)
  );
}

type DialogTemplateProps = {
  title: string;
  description?: string;
  main?: ReactNode;
  buttons?: ReactNode;
  leftButtons?: ReactNode;
  /**
   * Selection button configuration. Can be either:
   * - An object with selectHandler, selectClasses, selectText, isLoading (legacy)
   * - A ReactNode for custom selection component
   * @example
   * // Legacy usage
   * selection={{ selectHandler: () => {}, selectText: 'Confirm' }}
   * @example
   * // Custom component
   * selection={<Button onClick={handleConfirm}>Confirm</Button>}
   */
  selection?: SelectionProps | ReactNode;
  className?: string;
  overlayClassName?: string;
  headerClassName?: string;
  mainClassName?: string;
  footerClassName?: string;
  showCloseButton?: boolean;
  showCancelButton?: boolean;
  onClose?: () => void;
};

const OGDialogTemplate: ForwardRefExoticComponent<
  DialogTemplateProps & RefAttributes<HTMLDivElement>
> = forwardRef((props: DialogTemplateProps, ref: Ref<HTMLDivElement>) => {
  const localize = useLocalize();
  const {
    title,
    main,
    buttons,
    selection,
    className,
    leftButtons,
    description = '',
    mainClassName,
    headerClassName,
    footerClassName,
    showCloseButton = false,
    overlayClassName,
    showCancelButton = true,
  } = props;
  const isLegacySelection = isSelectionProps(selection);
  const legacySelection = isLegacySelection ? selection : null;
  const { selectHandler, selectClasses, selectText, isLoading } = legacySelection ?? {};

  const defaultSelect =
    'bg-surface-inverted text-text-inverted transition-colors hover:bg-surface-inverted-hover disabled:cursor-not-allowed disabled:opacity-50';

  let selectionContent = null;
  if (isLegacySelection) {
    selectionContent = (
      <OGDialogClose
        onClick={selectHandler}
        disabled={isLoading}
        className={`${
          selectClasses ?? defaultSelect
        } flex h-10 items-center justify-center rounded-lg border-none px-4 py-2 text-sm disabled:opacity-80 max-sm:order-first max-sm:w-full sm:order-none`}
      >
        {isLoading === true ? (
          <Spinner className="size-4 text-text-primary" />
        ) : (
          (selectText as React.JSX.Element)
        )}
      </OGDialogClose>
    );
  } else if (selection) {
    selectionContent = selection;
  }

  return (
    <OGDialogContent
      overlayClassName={overlayClassName}
      showCloseButton={showCloseButton}
      ref={ref}
      className={cn(
        /** `border-none` clears the default edge; the contrast variant has to
         *  restore the style as well as the width to survive it. */
        'w-11/12 border-none bg-surface-dialog text-text-primary high-contrast:border high-contrast:border-solid high-contrast:border-border-medium high-contrast:shadow-none',
        className ?? '',
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <OGDialogHeader className={cn(headerClassName ?? '')}>
        <OGDialogTitle>{title}</OGDialogTitle>
        {description && (
          <OGDialogDescription className="items-center justify-center">
            {description}
          </OGDialogDescription>
        )}
      </OGDialogHeader>
      <div className={cn('px-0 py-2', mainClassName)}>{main != null ? main : null}</div>
      <OGDialogFooter className={footerClassName}>
        {leftButtons != null ? (
          <div className="mr-auto flex flex-row gap-2">{leftButtons}</div>
        ) : null}
        {showCancelButton && (
          <OGDialogClose asChild>
            <Button variant="outline" aria-label={localize('com_ui_cancel')}>
              {localize('com_ui_cancel')}
            </Button>
          </OGDialogClose>
        )}
        {buttons != null ? buttons : null}
        {selectionContent}
      </OGDialogFooter>
    </OGDialogContent>
  );
});

export default OGDialogTemplate;
