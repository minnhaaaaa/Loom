"use client";

import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useState,
  type AriaAttributes,
  type ReactNode,
} from "react";
import { Select } from "@cloudflare/kumo/primitives/select";

type Option = { value: string; label: ReactNode; disabled: boolean };
function optionsFrom(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child): Option[] => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === Fragment) return optionsFrom(child.props.children);
    if (child.type !== "option") return [];
    return [
      {
        value: String(child.props.value ?? ""),
        label: child.props.children,
        disabled: Boolean(child.props.disabled),
      },
    ];
  });
}

type Props = AriaAttributes & {
  children: ReactNode;
  value: string | number;
  onChange: (event: { target: { value: string } }) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
};

/** One keyboard-accessible, themed menu for every workspace selector. */
export function LoomSelect({
  children,
  value,
  onChange,
  id,
  name,
  disabled,
  required,
  className = "",
  ...aria
}: Props) {
  const options = optionsFrom(children);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useCallback((element: HTMLButtonElement | null) => {
    if (element)
      setContainer(
        element.closest<HTMLElement>('dialog, [role="dialog"]') ||
          element.closest<HTMLElement>(".app-shell"),
      );
  }, []);
  return (
    <Select.Root
      id={id}
      name={name}
      value={String(value)}
      disabled={disabled}
      required={required}
      items={options}
      onValueChange={(next) => {
        if (next !== null) onChange({ target: { value: next } });
      }}
    >
      <Select.Trigger
        ref={triggerRef}
        data-value={String(value)}
        className={`loom-select ${className}`}
        {...aria}
      >
        <Select.Value className="loom-select-value" />
        <span className="loom-select-caret" aria-hidden="true" />
      </Select.Trigger>
      <Select.Portal container={container}>
        <Select.Positioner
          className="loom-select-positioner"
          positionMethod="fixed"
          sideOffset={5}
          alignItemWithTrigger={false}
          collisionPadding={12}
        >
          <Select.Popup className="loom-select-popup">
            <Select.List className="loom-select-list">
              {options.map((option) => (
                <Select.Item
                  className="loom-select-option"
                  key={option.value}
                  value={option.value}
                  data-value={option.value}
                  disabled={option.disabled}
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
