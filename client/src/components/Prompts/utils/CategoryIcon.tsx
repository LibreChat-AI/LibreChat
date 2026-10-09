import React from 'react';
import {
  Dices,
  BoxIcon,
  FileText,
  PenLineIcon,
  LightbulbIcon,
  LineChartIcon,
  ShoppingBagIcon,
  PlaneTakeoffIcon,
  GraduationCapIcon,
  TerminalSquareIcon,
  Users as UsersIcon,
  Beaker as BeakerIcon,
  Settings as SettingsIcon,
} from 'lucide-react';
import type { PromptCategoryColor, PromptCategoryIcon } from 'librechat-data-provider';
import { useGetCategories } from '~/data-provider';
import { cn } from '~/utils';

const configIconMap: Record<PromptCategoryIcon, React.ElementType> = {
  dices: Dices,
  box: BoxIcon,
  'file-text': FileText,
  'pen-line': PenLineIcon,
  lightbulb: LightbulbIcon,
  'line-chart': LineChartIcon,
  'shopping-bag': ShoppingBagIcon,
  'plane-takeoff': PlaneTakeoffIcon,
  'graduation-cap': GraduationCapIcon,
  'terminal-square': TerminalSquareIcon,
  users: UsersIcon,
  beaker: BeakerIcon,
  settings: SettingsIcon,
};

const configColorMap: Record<PromptCategoryColor, string> = {
  'series-1': 'text-series-1',
  'series-2': 'text-series-2',
  'series-3': 'text-series-3',
  'series-4': 'text-series-4',
  'series-5': 'text-series-5',
  'series-6': 'text-series-6',
  'series-7': 'text-series-7',
  'series-8': 'text-series-8',
};

const categoryIconMap: Record<string, React.ElementType> = {
  misc: BoxIcon,
  roleplay: Dices,
  write: PenLineIcon,
  idea: LightbulbIcon,
  shop: ShoppingBagIcon,
  finance: LineChartIcon,
  code: TerminalSquareIcon,
  travel: PlaneTakeoffIcon,
  teach_or_explain: GraduationCapIcon,
  general: BoxIcon,
  hr: UsersIcon,
  rd: BeakerIcon,
  it: TerminalSquareIcon,
  sales: LineChartIcon,
  aftersales: SettingsIcon,
};

const categoryColorMap: Record<string, string> = {
  code: 'text-series-5',
  misc: 'text-series-1',
  shop: 'text-series-6',
  idea: 'text-series-4',
  write: 'text-series-6',
  travel: 'text-series-4',
  finance: 'text-series-2',
  roleplay: 'text-series-2',
  teach_or_explain: 'text-series-1',
  general: 'text-series-1',
  hr: 'text-series-7',
  rd: 'text-series-6',
  it: 'text-series-5',
  sales: 'text-series-2',
  aftersales: 'text-series-4',
};

export default function CategoryIcon({
  category,
  className = '',
}: {
  category: string;
  className?: string;
}) {
  const { data: categories } = useGetCategories();
  const entry = categories?.find((c) => c.value === category);
  const IconComponent =
    (entry?.icon && configIconMap[entry.icon]) || categoryIconMap[category] || FileText;
  const colorClass =
    (entry?.color && configColorMap[entry.color]) ||
    categoryColorMap[category] ||
    'text-text-secondary';
  return <IconComponent className={cn('size-4', colorClass, className)} aria-hidden="true" />;
}
