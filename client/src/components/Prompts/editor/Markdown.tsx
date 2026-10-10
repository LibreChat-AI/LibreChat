import React from 'react';
import { handleDoubleClick } from '~/utils';

export const CodeVariableGfm: React.ElementType = ({ children }: { children: React.ReactNode }) => {
  return (
    <code
      onDoubleClick={handleDoubleClick}
      className="bg-surface-primary-alt text-text-secondary rounded-md p-1 text-xs md:text-sm"
    >
      {children}
    </code>
  );
};

const variableRegex = /{{(.*?)}}/g;

const highlightVariables = (text: string): React.ReactNode[] => {
  const parts = text.split(variableRegex);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <b
          key={index}
          className="bg-status-warning-subtle text-text-warning ml-[0.5] rounded-lg p-[1px] font-medium"
        >
          {`{{${part}}}`}
        </b>
      );
    }
    return part;
  });
};

const processChildren = (children: React.ReactNode): React.ReactNode => {
  if (typeof children === 'string') {
    return highlightVariables(children);
  }

  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <React.Fragment key={index}>{processChildren(child)}</React.Fragment>
    ));
  }

  if (React.isValidElement(children)) {
    const element = children as React.ReactElement<{ children?: React.ReactNode }>;
    if (typeof element.type !== 'string' || element.type === 'code') {
      return children;
    }
    if (element.props.children) {
      return React.cloneElement(element, {
        ...element.props,
        children: processChildren(element.props.children),
      });
    }
    return children;
  }

  return children;
};

export const PromptVariableGfm = ({
  children,
}: {
  children: React.ReactNode & React.ReactNode[];
}) => {
  return <p>{processChildren(children)}</p>;
};
