import { NotificationSeverity } from './enum';

export type TShowToast = {
  message: string;
  severity?: NotificationSeverity;
  showIcon?: boolean;
  duration?: number;
  status?: 'error' | 'success' | 'warning' | 'info';
};

export type Option = Record<string, unknown> & {
  label?: string;
  value: string | number | null;
};

export type OptionWithIcon = Option & {
  icon?: React.ReactNode;
  disabled?: boolean;
  description?: string;
};
export type DropdownValueSetter = (value: string | Option | OptionWithIcon) => void;
export type MentionOption = OptionWithIcon & {
  type: string;
  value: string;
  description?: string;
};

export interface SelectedValues {
  endpoint: string | null;
  model: string | null;
  modelSpec: string | null;
}
