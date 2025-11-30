window.replaceRules = [
  { find: /<span[^>]*>/g, replace: "" },
  { find: /<\/span>/g, replace: "" },
  { find: /style="[^"]*"/g, replace: "" },
  { find: /<script[\s\S]*?<\/script>/g, replace: "" },
];