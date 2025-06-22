targetScope = 'subscription'

@description('Primary location for all resources')
@metadata({
  azd: {
    type: 'location'
  }
})
param location string = 'westeurope'
param environmentName string

// Generate unique names for resources
var webappName = 'jsaibuildathon${uniqueString(subscription().id)}'
var webapiName = 'jsaiapi${uniqueString(subscription().id)}'
var appServicePlanName = 'asp-${environmentName}'

// Tags
var tags = {
  'azd-env-name': environmentName
}

// Resource abbreviations
var abbrs = {
  resourcesResourceGroups: 'rg'
}

// Resource group name
param rg string = ''

// Create resource group
resource resourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: 'rgbliss-free'
  location: location
  tags: tags
}

// Create App Service Plan with B1 tier
module serverfarm 'br/public:avm/res/web/serverfarm:0.4.1' = {
  name: 'appserviceplan'
  scope: resourceGroup
  params: {
    name: appServicePlanName
    location: location
    skuName: 'B1'
    tags: tags
  }
}

// Create Web API
module webapi 'br/public:avm/res/web/site:0.15.1' = {
  name: 'webapi'
  scope: resourceGroup
  params: {
    kind: 'app'
    name: webapiName
    location: location
    tags: tags
    serverFarmResourceId: serverfarm.outputs.resourceId
    siteConfig: {
      alwaysOn: true
    }
  }
}


// Create Static Web App
module webapp 'br/public:avm/res/web/static-site:0.7.0' = {
  name: 'webapp'
  scope: resourceGroup
  params: {
    name: webappName
    location: location
    tags: tags
    sku: 'Free'    // Free tier
  }
}

output WEBAPP_URL string = webapp.outputs.defaultHostname
output WEBAPI_URL string = webapi.outputs.defaultHostname
