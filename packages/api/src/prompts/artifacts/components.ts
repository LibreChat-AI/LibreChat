export interface ShadcnComponent {
  componentName: string;
  importDocs: string;
  usageDocs: string;
}

/** Essential Components */
const essentialComponents: Record<string, ShadcnComponent> = {
  avatar: {
    componentName: 'Avatar',
    importDocs: 'import { Avatar, AvatarFallback, AvatarImage } from "/components/ui/avatar"',
    usageDocs: `
<Avatar>
  <AvatarImage src="https://github.com/shadcn.png" />
  <AvatarFallback>CN</AvatarFallback>
</Avatar>`,
  },
  button: {
    componentName: 'Button',
    importDocs: 'import { Button } from "/components/ui/button"',
    usageDocs: `
<Button variant="outline">Button</Button>`,
  },
  card: {
    componentName: 'Card',
    importDocs: `
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "/components/ui/card"`,
    usageDocs: `
<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card Description</CardDescription>
  </CardHeader>
  <CardContent>
    <p>Card Content</p>
  </CardContent>
  <CardFooter>
    <p>Card Footer</p>
  </CardFooter>
</Card>`,
  },
  checkbox: {
    componentName: 'Checkbox',
    importDocs: 'import { Checkbox } from "/components/ui/checkbox"',
    usageDocs: '<Checkbox />',
  },
  input: {
    componentName: 'Input',
    importDocs: 'import { Input } from "/components/ui/input"',
    usageDocs: '<Input />',
  },
  label: {
    componentName: 'Label',
    importDocs: 'import { Label } from "/components/ui/label"',
    usageDocs: '<Label htmlFor="email">Your email address</Label>',
  },
  radioGroup: {
    componentName: 'RadioGroup',
    importDocs: `
import { Label } from "/components/ui/label"
import { RadioGroup, RadioGroupItem } from "/components/ui/radio-group"`,
    usageDocs: `
<RadioGroup defaultValue="option-one">
  <div className="flex items-center space-x-2">
    <RadioGroupItem value="option-one" id="option-one" />
    <Label htmlFor="option-one">Option One</Label>
  </div>
  <div className="flex items-center space-x-2">
    <RadioGroupItem value="option-two" id="option-two" />
    <Label htmlFor="option-two">Option Two</Label>
  </div>
</RadioGroup>`,
  },
  select: {
    componentName: 'Select',
    importDocs: `
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "/components/ui/select"`,
    usageDocs: `
<Select>
  <SelectTrigger className="w-[180px]">
    <SelectValue placeholder="Theme" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="light">Light</SelectItem>
    <SelectItem value="dark">Dark</SelectItem>
    <SelectItem value="system">System</SelectItem>
  </SelectContent>
</Select>`,
  },
  textarea: {
    componentName: 'Textarea',
    importDocs: 'import { Textarea } from "/components/ui/textarea"',
    usageDocs: '<Textarea />',
  },
};

/** Extra Components */
const extraComponents: Record<string, ShadcnComponent> = {
  accordion: {
    componentName: 'Accordion',
    importDocs: `
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "/components/ui/accordion"`,
    usageDocs: `
<Accordion type="single" collapsible>
  <AccordionItem value="item-1">
    <AccordionTrigger>Is it accessible?</AccordionTrigger>
    <AccordionContent>
      Yes. It adheres to the WAI-ARIA design pattern.
    </AccordionContent>
  </AccordionItem>
</Accordion>`,
  },
  alertDialog: {
    componentName: 'AlertDialog',
    importDocs: `
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "/components/ui/alert-dialog"`,
    usageDocs: `
<AlertDialog>
  <AlertDialogTrigger>Open</AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
      <AlertDialogDescription>
        This action cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction>Continue</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>`,
  },
  alert: {
    componentName: 'Alert',
    importDocs: `
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "/components/ui/alert"`,
    usageDocs: `
<Alert>
  <AlertTitle>Heads up!</AlertTitle>
  <AlertDescription>
    You can add components to your app using the cli.
  </AlertDescription>
</Alert>`,
  },
  badge: {
    componentName: 'Badge',
    importDocs: 'import { Badge } from "/components/ui/badge"',
    usageDocs: '<Badge>Badge</Badge>',
  },
  calendar: {
    componentName: 'Calendar',
    importDocs: 'import { Calendar } from "/components/ui/calendar"',
    usageDocs: '<Calendar />',
  },
  carousel: {
    componentName: 'Carousel',
    importDocs: `
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "/components/ui/carousel"`,
    usageDocs: `
<Carousel>
  <CarouselContent>
    <CarouselItem>...</CarouselItem>
    <CarouselItem>...</CarouselItem>
    <CarouselItem>...</CarouselItem>
  </CarouselContent>
  <CarouselPrevious />
  <CarouselNext />
</Carousel>`,
  },
  collapsible: {
    componentName: 'Collapsible',
    importDocs: `
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "/components/ui/collapsible"`,
    usageDocs: `
<Collapsible>
  <CollapsibleTrigger>Can I use this in my project?</CollapsibleTrigger>
  <CollapsibleContent>
    Yes. Free to use for personal and commercial projects. No attribution required.
  </CollapsibleContent>
</Collapsible>`,
  },
  dialog: {
    componentName: 'Dialog',
    importDocs: `
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "/components/ui/dialog"`,
    usageDocs: `
<Dialog>
  <DialogTrigger>Open</DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Are you sure absolutely sure?</DialogTitle>
      <DialogDescription>
        This action cannot be undone.
      </DialogDescription>
    </DialogHeader>
  </DialogContent>
</Dialog>`,
  },
  dropdownMenu: {
    componentName: 'DropdownMenu',
    importDocs: `
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "/components/ui/dropdown-menu"`,
    usageDocs: `
<DropdownMenu>
  <DropdownMenuTrigger>Open</DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuLabel>My Account</DropdownMenuLabel>
    <DropdownMenuSeparator />
    <DropdownMenuItem>Profile</DropdownMenuItem>
    <DropdownMenuItem>Billing</DropdownMenuItem>
    <DropdownMenuItem>Team</DropdownMenuItem>
    <DropdownMenuItem>Subscription</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>`,
  },
  menubar: {
    componentName: 'Menubar',
    importDocs: `
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "/components/ui/menubar"`,
    usageDocs: `
<Menubar>
  <MenubarMenu>
    <MenubarTrigger>File</MenubarTrigger>
    <MenubarContent>
      <MenubarItem>
        New Tab <MenubarShortcut>⌘T</MenubarShortcut>
      </MenubarItem>
      <MenubarItem>New Window</MenubarItem>
      <MenubarSeparator />
      <MenubarItem>Share</MenubarItem>
      <MenubarSeparator />
      <MenubarItem>Print</MenubarItem>
    </MenubarContent>
  </MenubarMenu>
</Menubar>`,
  },
  navigationMenu: {
    componentName: 'NavigationMenu',
    importDocs: `
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "/components/ui/navigation-menu"`,
    usageDocs: `
<NavigationMenu>
  <NavigationMenuList>
    <NavigationMenuItem>
      <NavigationMenuTrigger>Item One</NavigationMenuTrigger>
      <NavigationMenuContent>
        <NavigationMenuLink>Link</NavigationMenuLink>
      </NavigationMenuContent>
    </NavigationMenuItem>
  </NavigationMenuList>
</NavigationMenu>`,
  },
  popover: {
    componentName: 'Popover',
    importDocs: `
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "/components/ui/popover"`,
    usageDocs: `
<Popover>
  <PopoverTrigger>Open</PopoverTrigger>
  <PopoverContent>Place content for the popover here.</PopoverContent>
</Popover>`,
  },
  progress: {
    componentName: 'Progress',
    importDocs: 'import { Progress } from "/components/ui/progress"',
    usageDocs: '<Progress value={33} />',
  },
  separator: {
    componentName: 'Separator',
    importDocs: 'import { Separator } from "/components/ui/separator"',
    usageDocs: '<Separator />',
  },
  skeleton: {
    componentName: 'Skeleton',
    importDocs: 'import { Skeleton } from "/components/ui/skeleton"',
    usageDocs: '<Skeleton className="w-[100px] h-[20px] rounded-full" />',
  },
  slider: {
    componentName: 'Slider',
    importDocs: 'import { Slider } from "/components/ui/slider"',
    usageDocs: '<Slider defaultValue={[33]} max={100} step={1} />',
  },
  switch: {
    componentName: 'Switch',
    importDocs: 'import { Switch } from "/components/ui/switch"',
    usageDocs: '<Switch />',
  },
  table: {
    componentName: 'Table',
    importDocs: `
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "/components/ui/table"`,
    usageDocs: `
<Table>
  <TableCaption>A list of your recent invoices.</TableCaption>
  <TableHeader>
    <TableRow>
      <TableHead className="w-[100px]">Invoice</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Method</TableHead>
      <TableHead className="text-right">Amount</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell className="font-medium">INV001</TableCell>
      <TableCell>Paid</TableCell>
      <TableCell>Credit Card</TableCell>
      <TableCell className="text-right">$250.00</TableCell>
    </TableRow>
  </TableBody>
</Table>`,
  },
  tabs: {
    componentName: 'Tabs',
    importDocs: `
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "/components/ui/tabs"`,
    usageDocs: `
<Tabs defaultValue="account" className="w-[400px]">
  <TabsList>
    <TabsTrigger value="account">Account</TabsTrigger>
    <TabsTrigger value="password">Password</TabsTrigger>
  </TabsList>
  <TabsContent value="account">Make changes to your account here.</TabsContent>
  <TabsContent value="password">Change your password here.</TabsContent>
</Tabs>`,
  },
  toast: {
    componentName: 'Toast',
    importDocs: `
import { useToast } from "/components/ui/use-toast"
import { Button } from "/components/ui/button"`,
    usageDocs: `
export function ToastDemo() {
  const { toast } = useToast()
  return (
    <Button
      onClick={() => {
        toast({
          title: "Scheduled: Catch up",
          description: "Friday, February 10, 2023 at 5:57 PM",
        })
      }}
    >
      Show Toast
    </Button>
  )
}`,
  },
  toggle: {
    componentName: 'Toggle',
    importDocs: 'import { Toggle } from "/components/ui/toggle"',
    usageDocs: '<Toggle>Toggle</Toggle>',
  },
  tooltip: {
    componentName: 'Tooltip',
    importDocs: `
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "/components/ui/tooltip"`,
    usageDocs: `
<TooltipProvider>
  <Tooltip>
    <TooltipTrigger>Hover</TooltipTrigger>
    <TooltipContent>
      <p>Add to library</p>
    </TooltipContent>
  </Tooltip>
</TooltipProvider>`,
  },
};

export const components: Record<string, ShadcnComponent> = {
  ...essentialComponents,
  ...extraComponents,
};
