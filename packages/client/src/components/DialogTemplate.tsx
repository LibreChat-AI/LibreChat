import { forwardRef, ForwardRefExoticComponent, ReactNode, Ref, RefAttributes } from 'react';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './Dialog';
import { cn } from '~/utils/';

type SelectionProps = {
  selectHandler?: () => void;
  selectClasses?: string;
  selectText?: string;
};

type DialogTemplateProps = {
  title: string;
  description?: string;
  main?: ReactNode;
  buttons?: ReactNode;
  leftButtons?: ReactNode;
  selection?: SelectionProps;
  className?: string;
  headerClassName?: string;
  footerClassName?: string;
  showCloseButton?: boolean;
  showCancelButton?: boolean;
};

const DialogTemplate: ForwardRefExoticComponent<
  DialogTemplateProps & RefAttributes<HTMLDivElement>
> = forwardRef((props: DialogTemplateProps, ref: Ref<HTMLDivElement>) => {
  const {
    title,
    description,
    main,
    buttons,
    leftButtons,
    selection,
    className,
    headerClassName,
    footerClassName,
    showCloseButton,
    showCancelButton = true,
  } = props;
  const { selectHandler, selectClasses, selectText } = selection || {};
  const Cancel = 'cancel';

  const defaultSelect =
    'bg-surface-inverted text-text-inverted transition-colors hover:bg-surface-inverted-hover disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <DialogContent
      showCloseButton={showCloseButton}
      ref={ref}
      className={cn(
        'bg-surface-dialog shadow-2xl high-contrast:border high-contrast:border-solid high-contrast:border-border-medium high-contrast:shadow-none',
        className || '',
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <DialogHeader className={cn(headerClassName ?? '')}>
        <DialogTitle className="text-lg font-medium leading-6 text-text-primary">
          {title}
        </DialogTitle>
        {description && (
          <DialogDescription className="text-text-secondary">{description}</DialogDescription>
        )}
      </DialogHeader>
      <div className="px-6">{main ? main : null}</div>
      <DialogFooter className={footerClassName}>
        <div>{leftButtons ? leftButtons : null}</div>
        <div className="flex h-auto gap-3">
          {showCancelButton && (
            <DialogClose className="border-border-light hover:bg-surface-hover">
              {Cancel}
            </DialogClose>
          )}
          {buttons ? buttons : null}
          {selection ? (
            <DialogClose
              onClick={selectHandler}
              className={`${
                selectClasses || defaultSelect
              } inline-flex h-10 items-center justify-center rounded-lg border-none px-4 py-2 text-sm`}
            >
              {selectText}
            </DialogClose>
          ) : null}
        </div>
      </DialogFooter>
    </DialogContent>
  );
});

export default DialogTemplate;
