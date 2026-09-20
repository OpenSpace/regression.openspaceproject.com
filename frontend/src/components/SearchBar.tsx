import { ActionIcon, Group, Input, InputProps, Text } from '@mantine/core';
import { useState } from 'react';

interface SearchBarProps extends InputProps {
  onSearch: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({ onSearch, placeholder = 'Search...', ...props }: SearchBarProps) {
  const [value, setValue] = useState('');

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const searchValue = e.target.value;
    setValue(searchValue);
    onSearch(searchValue);
  };

  const clearSearch = () => {
    setValue('');
    onSearch('');
  };

  return (
    <Input
      placeholder={placeholder}
      value={value}
      onChange={handleSearch}
      leftSectionPointerEvents="none"
      leftSection={
        <Text c="dimmed">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </Text>
      }
      rightSection={
        value && (
          <ActionIcon onClick={clearSearch} size="xs" variant="subtle" c="dimmed">
            <Text size="xs">x</Text>
          </ActionIcon>
        )
      }
      {...props}
    />
  );
}