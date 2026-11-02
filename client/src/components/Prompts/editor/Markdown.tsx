import React from 'react';

const variableRegex = /{{(.*?)}}/g;

const highlightVariables = (text: string): React.ReactNode[] => {
  const parts = text.split(variableRegex);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <b
          key={index}
          className="bg-status-warning-subtle text-text-warning ms-[0.5] rounded-lg p-0.25 font-medium"
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
